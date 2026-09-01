/**
 * Bot AI.
 *
 * A small state machine rather than anything clever: decide whether this car is
 * the one going for the ball, and if not, get back toward its own goal. Skill
 * tiers come from how quickly a bot reacts, how accurately it aims, and which
 * mechanics it is allowed to use -- not from giving it different physics.
 */

import {
  BALL_COLLISION_RADIUS,
  BACK_WALL_Y,
  GOAL_THRESHOLD_Y,
  GRAVITY,
  TEAM_BLUE,
} from '../core/constants';
import { V, angleDelta, clamp, makeRandom, type Vec3 } from '../core/math';
import type { Car, CarInput } from '../physics/car';
import { neutralInput } from '../physics/car';
import type { World } from '../physics/world';

export type Difficulty = 'rookie' | 'pro' | 'ace';

interface Tier {
  /** Seconds between re-decisions -- the bot's reaction time. */
  thinkInterval: number;
  /** Radians of random aim error added to every target. */
  aimError: number;
  /** Boost is used when the bot is at least this well aligned. */
  boostAlignment: number;
  /** Probability of taking a speed-flip when it is available. */
  flipChance: number;
  /** Whether the bot will jump for balls off the ground. */
  aerials: boolean;
  /** Fraction of the ball's predicted flight the bot leads by. */
  prediction: number;
  /** Upper bound on how much of the tank the bot is willing to spend. */
  boostFloor: number;
}

const TIERS: Record<Difficulty, Tier> = {
  rookie: {
    thinkInterval: 0.34,
    aimError: 0.22,
    boostAlignment: 0.97,
    flipChance: 0.05,
    aerials: false,
    prediction: 0.25,
    boostFloor: 40,
  },
  pro: {
    thinkInterval: 0.16,
    aimError: 0.09,
    boostAlignment: 0.9,
    flipChance: 0.35,
    aerials: true,
    prediction: 0.65,
    boostFloor: 12,
  },
  ace: {
    thinkInterval: 0.06,
    aimError: 0.03,
    boostAlignment: 0.82,
    flipChance: 0.7,
    aerials: true,
    prediction: 1,
    boostFloor: 0,
  },
};

type Mode = 'attack' | 'defend' | 'rotate' | 'boost' | 'recover';

export class Bot {
  mode: Mode = 'attack';
  private timer = 0;
  private aimOffset = 0;
  private target: Vec3 = V.zero();
  private readonly tier: Tier;
  private readonly random: () => number;
  private jumpHeld = false;
  private dodgeArmed = 0;

  constructor(
    readonly car: Car,
    readonly difficulty: Difficulty,
    seed = 1,
  ) {
    this.tier = TIERS[difficulty];
    this.random = makeRandom(seed * 7919 + car.index * 104729);
  }

  /** Direction this bot's team attacks. */
  private get attackSign(): number {
    return this.car.team === TEAM_BLUE ? 1 : -1;
  }

  private get ownGoal(): Vec3 {
    return V.make(0, -this.attackSign * BACK_WALL_Y, 200);
  }

  private get targetGoal(): Vec3 {
    return V.make(0, this.attackSign * GOAL_THRESHOLD_Y, 250);
  }

  think(world: World, dt: number): CarInput {
    const car = this.car;
    if (car.demolished) return neutralInput();

    this.timer -= dt;
    this.dodgeArmed = Math.max(0, this.dodgeArmed - dt);
    if (this.timer <= 0) {
      this.timer = this.tier.thinkInterval;
      this.decide(world);
    }

    return this.drive(world);
  }

  // ------------------------------------------------------------------ decide

  private decide(world: World): void {
    const car = this.car;
    const ball = world.ball;
    this.aimOffset = (this.random() - 0.5) * 2 * this.tier.aimError;

    const contact = this.predictContact(world);
    const ballBehindMe = (ball.position.y - car.position.y) * this.attackSign < -400;
    const closest = this.isClosestTeammate(world, contact);

    // Concede the ball when a team-mate is clearly better placed, and get back
    // instead. Two bots both charging the ball is the classic failure.
    if (!closest) {
      this.mode = car.boost < 45 ? 'boost' : 'rotate';
    } else if (ballBehindMe && this.dangerNearOwnGoal(world)) {
      this.mode = 'defend';
    } else {
      this.mode = 'attack';
    }

    if (car.boost <= 4 && this.mode !== 'defend' && this.random() < 0.7) {
      this.mode = 'boost';
    }
    if (!car.onGround && car.position.z > 400 && !this.tier.aerials) {
      this.mode = 'recover';
    }

    this.target = this.pickTarget(world, contact);
  }

  private isClosestTeammate(world: World, contact: Vec3): boolean {
    const mine = V.distance(this.car.position, contact);
    for (const other of world.cars) {
      if (other === this.car || other.team !== this.car.team || other.demolished) continue;
      if (V.distance(other.position, contact) < mine - 120) return false;
    }
    return true;
  }

  private dangerNearOwnGoal(world: World): boolean {
    const ball = world.ball;
    const towardOwn = -this.attackSign;
    return ball.position.y * towardOwn > 1200 || ball.velocity.y * towardOwn > 900;
  }

  /**
   * Where the ball will be when we could plausibly reach it. Ballistic only --
   * no wall bounces -- which is enough for interception and keeps this cheap.
   */
  private predictContact(world: World): Vec3 {
    const ball = world.ball;
    const distance = V.distance(this.car.position, ball.position);
    const closingSpeed = Math.max(700, this.car.speed);
    const time = clamp((distance / closingSpeed) * this.tier.prediction, 0, 1.6);

    const p = V.addScaled(ball.position, ball.velocity, time);
    const dropped = p.z - 0.5 * GRAVITY * time * time;
    return V.make(p.x, p.y, Math.max(BALL_COLLISION_RADIUS, dropped));
  }

  private pickTarget(world: World, contact: Vec3): Vec3 {
    switch (this.mode) {
      case 'attack': {
        // Aim at the far side of the ball from the goal we are shooting at, so
        // contact sends it goalward rather than just into it.
        const goal = this.targetGoal;
        const away = V.normalize(V.sub(contact, goal));
        return V.addScaled(contact, away, BALL_COLLISION_RADIUS * 0.9);
      }
      case 'defend': {
        const goal = this.ownGoal;
        const toBall = V.normalize(V.sub(contact, goal));
        // Sit between the ball and our net rather than charging the ball.
        return V.addScaled(goal, toBall, 900);
      }
      case 'rotate': {
        const goal = this.ownGoal;
        // Rotate to a post, not the middle of the net -- keeps the lane open.
        const side = this.car.position.x >= 0 ? 1 : -1;
        return V.make(side * 1500, goal.y + this.attackSign * 1500, 20);
      }
      case 'boost':
        return this.nearestPad(world) ?? contact;
      case 'recover':
        return V.make(this.car.position.x, this.car.position.y, 20);
    }
  }

  /** Best boost pad: nearest, weighted to prefer big pads and stay goal-side. */
  private nearestPad(world: World): Vec3 | null {
    let best: Vec3 | null = null;
    let bestScore = Infinity;
    for (const pad of world.pads) {
      if (!pad.active) continue;
      const distance = V.distance(this.car.position, pad.position);
      if (distance > 5200) continue;
      const value = pad.big ? 0.42 : 1;
      const backwards = (pad.position.y - this.car.position.y) * this.attackSign < 0 ? 0.85 : 1;
      const score = distance * value * backwards;
      if (score < bestScore) {
        bestScore = score;
        best = pad.position;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------- drive

  private drive(world: World): CarInput {
    const car = this.car;
    const input = neutralInput();

    if (!car.onGround) return this.airRecover(world, input);

    const toTarget = V.sub(this.target, car.position);
    const desired = Math.atan2(toTarget.y, toTarget.x) + this.aimOffset;
    const heading = Math.atan2(car.forward.y, car.forward.x);
    const error = angleDelta(heading, desired);
    const distance = V.length(toTarget);

    // Steer is negative for a right turn, so drive it from the heading error.
    input.steer = clamp(-error * 2.4, -1, 1);
    input.throttle = 1;

    const alignment = Math.cos(error);

    // Reverse out instead of grinding a circle when the target is behind us.
    if (Math.abs(error) > 2.3 && distance < 900) {
      input.throttle = -1;
      input.steer = -input.steer;
    }

    // Powerslide through hard corners: tighter rotation without a brake's cost.
    input.handbrake = Math.abs(error) > 1.25 && car.speed > 700;

    // Boost only when it is actually going where we want, and keep a reserve
    // unless the tier says otherwise.
    input.boost =
      alignment > this.tier.boostAlignment &&
      car.boost > this.tier.boostFloor &&
      distance > 700 &&
      !input.handbrake;

    // Speed-flip on long straight runs: free speed with no boost cost.
    if (
      this.mode !== 'defend' &&
      distance > 2200 &&
      alignment > 0.985 &&
      car.speed > 1100 &&
      car.speed < 2150 &&
      this.dodgeArmed === 0 &&
      this.random() < this.tier.flipChance
    ) {
      this.dodgeArmed = 1.4;
      this.jumpHeld = true;
    }

    if (this.jumpHeld) {
      input.jump = true;
      // Release before the second press so the flip actually registers.
      if (this.dodgeArmed < 1.28) this.jumpHeld = false;
    }

    // Jump to meet a ball that is off the ground and close.
    if (this.tier.aerials && this.shouldChallengeInAir(world, distance, alignment)) {
      input.jump = true;
      input.boost = car.boost > 20;
    }

    return input;
  }

  private shouldChallengeInAir(world: World, distance: number, alignment: number): boolean {
    const ball = world.ball;
    if (this.mode !== 'attack') return false;
    if (ball.position.z < 220) return false;
    if (distance > 1400 || alignment < 0.9) return false;
    return this.random() < 0.5;
  }

  /**
   * In the air: point the nose where we want to go and level the wheels for
   * landing. Rookies skip the aerial entirely and just recover.
   */
  private airRecover(world: World, input: CarInput): CarInput {
    const car = this.car;
    const ball = world.ball;

    const chasing =
      this.tier.aerials && this.mode === 'attack' && V.distance(car.position, ball.position) < 2000;
    const aim = chasing
      ? V.normalize(V.sub(ball.position, car.position))
      : V.normalize(V.make(car.velocity.x, car.velocity.y, -260));

    // Pitch and yaw toward the aim direction, roll to bring the wheels level.
    const localAim = {
      forward: V.dot(aim, car.forward),
      left: V.dot(aim, car.left),
      up: V.dot(aim, car.up),
    };
    input.pitch = clamp(localAim.up * 2.2, -1, 1);
    input.yaw = clamp(-localAim.left * 2.2, -1, 1);

    // Roll so the roof faces world up; below the aim tolerance this is what
    // turns a tumbling car into a clean landing.
    const rollError = V.dot(V.make(0, 0, 1), car.left);
    input.roll = clamp(rollError * 2.5, -1, 1);

    if (chasing && localAim.forward > 0.9 && car.boost > 15) input.boost = true;

    // Only flip into the ball when it is right in front of us.
    if (chasing && V.distance(car.position, ball.position) < 320 && car.canDodge) {
      input.jump = true;
      input.pitch = -1;
    }

    return input;
  }
}
