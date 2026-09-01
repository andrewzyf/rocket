/**
 * The simulation world: cars, ball, boost pads, and the interactions between
 * them. Steps at a fixed 120 Hz and emits events for the presentation layer to
 * react to, so nothing in here needs to know that a renderer exists.
 */

import { M, V, type Vec3 } from '../core/math';
import {
  BALL_COLLISION_RADIUS,
  BIG_PAD_AMOUNT,
  BIG_PAD_RADIUS,
  BIG_PAD_RESPAWN,
  BOOST_PADS,
  BOOST_START,
  CAR_MASS,
  DEMO_FORWARD_CONE,
  DEMO_IMPACT_MAX,
  DEMO_RESPAWN,
  GOAL_THRESHOLD_Y,
  KICKOFF_ASSIGNMENT,
  KICKOFF_SPAWNS,
  PAD_HEIGHT,
  RESPAWN_SPOTS,
  SMALL_PAD_AMOUNT,
  SMALL_PAD_RADIUS,
  SMALL_PAD_RESPAWN,
  SPAWN_Z,
  TEAM_BLUE,
} from '../core/constants';
import { Ball } from './ball';
import { Car, neutralInput, type CarInput } from './car';
import { obbOverlap, type Obb } from './collision';
import { field, Field } from './field';

export interface BoostPadState {
  position: Vec3;
  big: boolean;
  radius: number;
  active: boolean;
  timer: number;
}

export type WorldEvent =
  | { type: 'goal'; team: number; scorer: Car | null }
  | { type: 'ball-touch'; car: Car; impulse: number; point: Vec3 }
  | { type: 'ball-bounce'; impulse: number; position: Vec3 }
  | { type: 'boost-pickup'; car: Car; big: boolean; position: Vec3 }
  | { type: 'demolition'; attacker: Car; victim: Car; position: Vec3 }
  | { type: 'bump'; a: Car; b: Car; impulse: number; position: Vec3 }
  | { type: 'jump'; car: Car }
  | { type: 'dodge'; car: Car }
  | { type: 'land'; car: Car; impact: number };

/** Minimum closing speed before a car-car contact is worth a sound. */
const BUMP_AUDIBLE_SPEED = 250;

export class World {
  readonly cars: Car[] = [];
  readonly ball = new Ball();
  readonly pads: BoostPadState[] = [];
  readonly field: Field = field;

  /** Drained by the presentation layer each frame. */
  events: WorldEvent[] = [];

  /** Set while a goal has been scored and the reset has not yet happened. */
  goalScored: { team: number; scorer: Car | null } | null = null;

  /** Cars are frozen during the kickoff countdown. */
  frozen = false;

  /** Last car of each team to touch the ball, for goal attribution. */
  private lastTouchByTeam: (Car | null)[] = [null, null];
  private lastTouch: Car | null = null;

  private wasGrounded: boolean[] = [];
  private wasDodging: boolean[] = [];
  private wasJumping: boolean[] = [];

  constructor() {
    for (const spec of BOOST_PADS) {
      this.pads.push({
        position: V.make(spec.x, spec.y, spec.z),
        big: spec.big,
        radius: spec.big ? BIG_PAD_RADIUS : SMALL_PAD_RADIUS,
        active: true,
        timer: 0,
      });
    }
  }

  /** Remove every car, so the roster can be rebuilt for a new team size. */
  clearCars(): void {
    this.cars.length = 0;
    this.wasGrounded.length = 0;
    this.wasDodging.length = 0;
    this.wasJumping.length = 0;
    this.lastTouch = null;
    this.lastTouchByTeam = [null, null];
  }

  addCar(car: Car): void {
    this.cars.push(car);
    this.wasGrounded.push(true);
    this.wasDodging.push(false);
    this.wasJumping.push(false);
  }

  /** Reset everything for a kickoff. */
  kickoff(): void {
    const perTeam: Car[][] = [[], []];
    for (const car of this.cars) perTeam[car.team].push(car);

    for (const team of [0, 1]) {
      const roster = perTeam[team];
      const slots =
        KICKOFF_ASSIGNMENT[roster.length] ??
        KICKOFF_SPAWNS.map((_, i) => i).slice(0, roster.length);
      roster.forEach((car, i) => {
        const spec = KICKOFF_SPAWNS[slots[i % slots.length]];
        const mirror = team === TEAM_BLUE ? 1 : -1;
        car.reset(
          V.make(spec.x * mirror, spec.y * mirror, SPAWN_Z),
          team === TEAM_BLUE ? spec.yaw : spec.yaw + Math.PI,
          BOOST_START,
        );
      });
    }

    this.ball.reset(V.make(0, 0, BALL_COLLISION_RADIUS));
    for (const pad of this.pads) {
      pad.active = true;
      pad.timer = 0;
    }
    this.goalScored = null;
    this.lastTouch = null;
    this.lastTouchByTeam = [null, null];
    this.events.length = 0;
  }

  step(inputs: Map<Car, CarInput>, dt: number): void {
    const frozenInput = neutralInput();

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const input = this.frozen ? frozenInput : (inputs.get(car) ?? frozenInput);

      const wasAir = !this.wasGrounded[i];
      const hadDodge = this.wasDodging[i];
      const hadJumped = this.wasJumping[i];

      car.step(input, dt, field);

      if (car.demolished) {
        if (car.respawnTimer <= 0) this.respawn(car);
        continue;
      }

      if (!hadJumped && car.jumped) this.events.push({ type: 'jump', car });
      if (!hadDodge && car.isDodging) this.events.push({ type: 'dodge', car });
      if (wasAir && car.onGround) {
        this.events.push({ type: 'land', car, impact: Math.abs(car.speed) });
      }

      this.wasGrounded[i] = car.onGround;
      this.wasDodging[i] = car.isDodging;
      this.wasJumping[i] = car.jumped;

      this.collectPads(car);
    }

    this.resolveCarCollisions();

    {
      // The ball keeps simulating during the countdown so it settles on the
      // spot; cars are the only thing the freeze applies to.
      for (const car of this.cars) {
        if (car.demolished) continue;
        if (this.ball.collideWithCar(car)) {
          const touch = this.ball.lastTouch;
          if (touch) {
            this.lastTouch = car;
            this.lastTouchByTeam[car.team] = car;
            this.events.push({
              type: 'ball-touch',
              car,
              impulse: touch.impulse,
              point: touch.point,
            });
          }
          // Any wheel contact with the ball re-arms the flip -- the "flip reset".
          if (!car.onGround && this.ballUnderWheels(car)) car.resetFlip();
        }
      }
      this.ball.step(dt, field);
      if (this.ball.lastSurfaceImpulse > 200) {
        this.events.push({
          type: 'ball-bounce',
          impulse: this.ball.lastSurfaceImpulse,
          position: V.clone(this.ball.position),
        });
      }
    }

    this.checkGoal();
    this.tickPads(dt);
  }

  /**
   * True when the ball is below the car's hitbox, i.e. touching where the
   * wheels are. That is the condition for a flip reset.
   */
  private ballUnderWheels(car: Car): boolean {
    const local = M.mulTVec(car.orientation, V.sub(this.ball.position, car.hitboxCenter));
    return local.z < -car.body.halfExtents.z * 0.5;
  }

  private checkGoal(): void {
    if (this.goalScored) return;
    const side = Field.isGoal(this.ball.position.y, GOAL_THRESHOLD_Y);
    if (side === 0) return;
    // A ball crossing the +y line is a goal for the team defending -y (blue).
    const team = side === 1 ? 0 : 1;
    const scorer = this.lastTouchByTeam[team] ?? this.lastTouch;
    this.goalScored = { team, scorer };
    this.events.push({ type: 'goal', team, scorer });
  }

  // --------------------------------------------------------------- boost pads

  private collectPads(car: Car): void {
    if (car.demolished) return;
    for (const pad of this.pads) {
      if (!pad.active) continue;
      const dx = car.position.x - pad.position.x;
      const dy = car.position.y - pad.position.y;
      const dz = car.position.z - pad.position.z;
      if (dz < -PAD_HEIGHT || dz > PAD_HEIGHT) continue;
      if (dx * dx + dy * dy > pad.radius * pad.radius) continue;
      // Big pads always fire; small pads are wasted on a full tank, same as the
      // reference game, so a full car can drive over them and leave them up.
      if (!pad.big && car.boost >= 100) continue;

      car.collectBoost(pad.big ? BIG_PAD_AMOUNT : SMALL_PAD_AMOUNT);
      pad.active = false;
      pad.timer = pad.big ? BIG_PAD_RESPAWN : SMALL_PAD_RESPAWN;
      this.events.push({
        type: 'boost-pickup',
        car,
        big: pad.big,
        position: pad.position,
      });
    }
  }

  private tickPads(dt: number): void {
    for (const pad of this.pads) {
      if (pad.active) continue;
      pad.timer -= dt;
      if (pad.timer <= 0) {
        pad.active = true;
        pad.timer = 0;
      }
    }
  }

  // ------------------------------------------------------------ car vs car

  private obbFor(car: Car): Obb {
    const h = car.body.halfExtents;
    return {
      center: car.hitboxCenter,
      orientation: car.orientation,
      halfExtents: V.make(h.x, h.y, h.z),
    };
  }

  private resolveCarCollisions(): void {
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i];
        const b = this.cars[j];
        if (a.demolished || b.demolished) continue;

        const hit = obbOverlap(this.obbFor(a), this.obbFor(b));
        if (!hit) continue;

        const aKills = this.canDemolish(a, b, hit.point);
        const bKills = this.canDemolish(b, a, hit.point);

        if (aKills || bKills) {
          // `destroy(victim, attacker)`: when A has the kill, B is the one that
          // goes. Both supersonic and nose to nose means both cars go.
          if (aKills) this.destroy(b, a, hit.point);
          if (bKills) this.destroy(a, b, hit.point);
          continue;
        }

        this.resolveBump(a, b, hit.normal, hit.depth, hit.point);
      }
    }
  }

  /**
   * Demolition gate (DESIGN.md 11): the attacker must be supersonic and must
   * make contact with its front. Without the angle checks, being clipped from
   * behind by a fast car would kill you, which is not how it should read.
   */
  private canDemolish(attacker: Car, victim: Car, point: Vec3): boolean {
    if (!attacker.supersonic) return false;

    const toImpact = V.normalize(V.sub(point, attacker.position));
    const forward = attacker.forward;
    if (V.lengthSq(toImpact) < 1e-6) return false;
    if (Math.acos(Math.max(-1, Math.min(1, V.dot(toImpact, forward)))) > DEMO_FORWARD_CONE) {
      return false;
    }

    // The victim must be on the far side of the impact from the attacker.
    // The community teardown quotes a 55-90 degree band here, but taken
    // literally that would rule out head-on demolitions, which plainly do
    // happen -- so we use the upper bound only. Flagged in DESIGN.md 14 as
    // unverified.
    const impactToVictim = V.normalize(V.sub(victim.position, point));
    if (V.lengthSq(impactToVictim) < 1e-6) return true;
    const angle = Math.acos(Math.max(-1, Math.min(1, V.dot(impactToVictim, forward))));
    return angle <= DEMO_IMPACT_MAX;
  }

  private destroy(victim: Car, attacker: Car, point: Vec3): void {
    victim.demolish();
    victim.respawnTimer = DEMO_RESPAWN;
    this.events.push({ type: 'demolition', attacker, victim, position: V.clone(point) });
  }

  /** Momentum-transfer bump for sub-supersonic contact. */
  private resolveBump(a: Car, b: Car, normal: Vec3, depth: number, point: Vec3): void {
    const half = depth * 0.5;
    a.position = V.addScaled(a.position, normal, -half);
    b.position = V.addScaled(b.position, normal, half);

    const relative = V.sub(b.velocity, a.velocity);
    const closing = V.dot(relative, normal);
    if (closing >= 0) return;

    const restitution = 0.35;
    const j = (-(1 + restitution) * closing) / (2 / CAR_MASS);
    const impulse = V.scale(normal, j);
    a.velocity = V.addScaled(a.velocity, impulse, -1 / CAR_MASS);
    b.velocity = V.addScaled(b.velocity, impulse, 1 / CAR_MASS);

    if (Math.abs(closing) > BUMP_AUDIBLE_SPEED) {
      this.events.push({ type: 'bump', a, b, impulse: Math.abs(j), position: V.clone(point) });
    }
  }

  private respawn(car: Car): void {
    const mirror = car.team === TEAM_BLUE ? 1 : -1;
    // Pick the free spawn furthest from every other car so nobody lands on top
    // of a team-mate.
    let best = RESPAWN_SPOTS[0];
    let bestScore = -Infinity;
    for (const spot of RESPAWN_SPOTS) {
      const p = V.make(spot.x * mirror, spot.y * mirror, SPAWN_Z);
      let score = Infinity;
      for (const other of this.cars) {
        if (other === car || other.demolished) continue;
        score = Math.min(score, V.distance(p, other.position));
      }
      if (score > bestScore) {
        bestScore = score;
        best = spot;
      }
    }
    car.reset(
      V.make(best.x * mirror, best.y * mirror, SPAWN_Z),
      car.team === TEAM_BLUE ? best.yaw : best.yaw + Math.PI,
      BOOST_START,
    );
  }
}
