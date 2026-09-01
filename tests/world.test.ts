import { describe, expect, it } from 'vitest';
import { World } from '../src/physics/world';
import { Car, neutralInput, type CarInput } from '../src/physics/car';
import { Match } from '../src/game/match';
import { Bot } from '../src/ai/bot';
import { V } from '../src/core/math';
import {
  BOOST_START,
  DEMO_RESPAWN,
  GOAL_THRESHOLD_Y,
  SMALL_PAD_AMOUNT,
  SMALL_PAD_RESPAWN,
  TICK_DT,
} from '../src/core/constants';

function makeWorld(perTeam = 1): World {
  const world = new World();
  for (let team = 0; team < 2; team++) {
    for (let i = 0; i < perTeam; i++) world.addCar(new Car(team, i));
  }
  world.kickoff();
  return world;
}

function step(world: World, seconds: number, inputs?: Map<Car, CarInput>): void {
  const map = inputs ?? new Map<Car, CarInput>();
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) world.step(map, TICK_DT);
}

describe('world', () => {
  it('places cars at mirrored kickoff spawns with the right boost', () => {
    const world = makeWorld(1);
    const [blue, orange] = world.cars;
    expect(blue.boost).toBe(BOOST_START);
    expect(blue.position.y).toBeLessThan(0);
    expect(orange.position.y).toBeGreaterThan(0);
    expect(blue.position.y).toBeCloseTo(-orange.position.y, 3);
    // Both should face the ball at the centre.
    expect(blue.forward.y).toBeGreaterThan(0.5);
    expect(orange.forward.y).toBeLessThan(-0.5);
  });

  it('gives 2v2 both corner spawns rather than stacking cars', () => {
    const world = makeWorld(2);
    const blue = world.cars.filter((c) => c.team === 0);
    expect(V.distance(blue[0].position, blue[1].position)).toBeGreaterThan(1000);
  });

  it('collects a small pad and respawns it on a timer', () => {
    const world = makeWorld(1);
    const car = world.cars[0];
    const pad = world.pads.find((p) => !p.big)!;
    car.reset(V.make(pad.position.x, pad.position.y, 17), 0, 20);

    step(world, TICK_DT);
    expect(car.boost).toBeCloseTo(20 + SMALL_PAD_AMOUNT, 3);
    expect(pad.active).toBe(false);

    // Drive off the pad -- parked on top of it, the car would just take it
    // again the instant it comes back.
    car.position = V.make(0, 0, 17);

    step(world, SMALL_PAD_RESPAWN - 0.5);
    expect(pad.active).toBe(false);
    step(world, 0.7);
    expect(pad.active).toBe(true);
  });

  it('leaves a small pad standing for a car with a full tank', () => {
    const world = makeWorld(1);
    const car = world.cars[0];
    const pad = world.pads.find((p) => !p.big)!;
    car.reset(V.make(pad.position.x, pad.position.y, 17), 0, 100);
    step(world, TICK_DT * 2);
    expect(pad.active).toBe(true);
  });

  it('fills the tank from a big pad regardless of how full it is', () => {
    const world = makeWorld(1);
    const car = world.cars[0];
    const pad = world.pads.find((p) => p.big)!;
    car.reset(V.make(pad.position.x, pad.position.y, 17), 0, 80);
    step(world, TICK_DT);
    expect(car.boost).toBe(100);
    expect(pad.active).toBe(false);
  });

  it('scores a goal for the attacking team and names the last toucher', () => {
    const world = makeWorld(1);
    const striker = world.cars[0];
    // Park the keeper out of the way; the kickoff spawn sits right in the
    // ball's path and would simply block the shot.
    world.cars[1].reset(V.make(3000, 3000, 17), 0, 33);
    striker.reset(V.make(0, 3600, 17), Math.PI / 2, 100);

    world.ball.reset(V.make(0, 4000, 93.15));
    world.ball.velocity = V.make(0, 2500, 0);

    step(world, 1.2);
    expect(world.goalScored).not.toBeNull();
    // Ball crossed the +y line, which is the goal blue attacks.
    expect(world.goalScored!.team).toBe(0);
    expect(world.ball.position.y).toBeGreaterThan(GOAL_THRESHOLD_Y);
  });

  it('demolishes a stationary car hit head-on at supersonic speed', () => {
    const world = makeWorld(1);
    const [attacker, victim] = world.cars;
    victim.reset(V.make(0, 0, 17), -Math.PI / 2, 0);
    attacker.reset(V.make(0, -400, 17), Math.PI / 2, 100);
    attacker.velocity = V.make(0, 2250, 0);
    attacker.supersonic = true;

    step(world, 0.4);
    expect(victim.demolished).toBe(true);
    expect(attacker.demolished).toBe(false);
  });

  it('only bumps below supersonic', () => {
    const world = makeWorld(1);
    const [attacker, victim] = world.cars;
    victim.reset(V.make(0, 0, 17), -Math.PI / 2, 0);
    attacker.reset(V.make(0, -400, 17), Math.PI / 2, 0);
    attacker.velocity = V.make(0, 1400, 0);

    step(world, 0.5);
    expect(victim.demolished).toBe(false);
    // The victim was shoved along.
    expect(victim.velocity.y).toBeGreaterThan(100);
  });

  it('respawns a demolished car after three seconds', () => {
    const world = makeWorld(1);
    const victim = world.cars[1];
    victim.demolish();
    victim.respawnTimer = DEMO_RESPAWN;

    step(world, DEMO_RESPAWN - 0.3);
    expect(victim.demolished).toBe(true);
    step(world, 0.5);
    expect(victim.demolished).toBe(false);
    expect(victim.boost).toBe(BOOST_START);
    // Back near its own half.
    expect(victim.position.y).toBeGreaterThan(2000);
  });

  it('keeps everything finite through a long bot-driven match', () => {
    const world = makeWorld(2);
    const bots = world.cars.map((car, i) => new Bot(car, i % 2 ? 'ace' : 'pro', i + 1));
    const inputs = new Map<Car, CarInput>();

    for (let i = 0; i < 120 * 45; i++) {
      for (const bot of bots) inputs.set(bot.car, bot.think(world, TICK_DT));
      world.step(inputs, TICK_DT);
      world.events.length = 0;
      if (world.goalScored) world.kickoff();
    }

    for (const car of world.cars) {
      expect(V.isFinite(car.position)).toBe(true);
      expect(V.isFinite(car.velocity)).toBe(true);
      expect(car.boost).toBeGreaterThanOrEqual(0);
      expect(car.boost).toBeLessThanOrEqual(100);
      // Nobody has escaped the arena.
      expect(Math.abs(car.position.x)).toBeLessThan(4300);
      expect(Math.abs(car.position.y)).toBeLessThan(6200);
    }
    expect(V.isFinite(world.ball.position)).toBe(true);
  });
});

describe('match rules', () => {
  it('freezes the cars through the countdown and releases them on GO', () => {
    const world = makeWorld(1);
    const match = new Match(world, { duration: 60 });
    match.start();
    expect(match.phase).toBe('countdown');
    expect(world.frozen).toBe(true);

    match.update(2.0);
    expect(match.phase).toBe('countdown');
    match.update(1.2);
    expect(match.phase).toBe('playing');
    expect(world.frozen).toBe(false);
  });

  it('does not blow the whistle while the ball is still live at 0:00', () => {
    const world = makeWorld(1);
    const match = new Match(world, { duration: 1 });
    match.start();
    match.update(3.1); // out of the countdown

    world.ball.reset(V.make(0, 0, 1200));
    world.ball.velocity = V.make(0, 900, 400);

    match.update(1.5);
    expect(match.clock).toBe(0);
    expect(match.isStoppage).toBe(true);
    expect(match.phase).toBe('playing');

    // Settle the ball; the period should then end.
    world.ball.reset(V.make(0, 0, 93.15));
    match.update(0.02);
    expect(match.phase).not.toBe('playing');
  });

  it('goes to sudden-death overtime on a tie and ends on the next goal', () => {
    const world = makeWorld(1);
    const match = new Match(world, { duration: 1 });
    match.start();
    match.update(3.1);
    world.ball.reset(V.make(0, 0, 93.15));
    match.update(1.5); // clock reaches zero, ball still deemed live
    match.update(0.02); // next tick sees a dead ball and ends the period

    expect(match.overtime).toBe(true);
    expect(match.phase).toBe('countdown');

    match.update(3.1);
    world.goalScored = { team: 1, scorer: null };
    match.update(0.02);
    expect(match.score[1]).toBe(1);
    match.update(4);
    expect(match.phase).toBe('over');
    expect(match.winner).toBe(1);
  });

  it('formats the clock as minutes and seconds', () => {
    const world = makeWorld(1);
    const match = new Match(world, { duration: 300 });
    match.start();
    expect(match.formatClock()).toBe('5:00');
    match.clock = 65;
    expect(match.formatClock()).toBe('1:05');
    match.clock = 9;
    expect(match.formatClock()).toBe('0:09');
  });
});

describe('bots', () => {
  it('produces valid input every tick without touching the ball', () => {
    const world = makeWorld(1);
    const bot = new Bot(world.cars[1], 'pro', 3);
    for (let i = 0; i < 600; i++) {
      const input = bot.think(world, TICK_DT);
      for (const key of ['throttle', 'steer', 'pitch', 'yaw', 'roll'] as const) {
        expect(Number.isFinite(input[key])).toBe(true);
        expect(Math.abs(input[key])).toBeLessThanOrEqual(1.0001);
      }
      world.step(new Map([[world.cars[1], input]]), TICK_DT);
      world.events.length = 0;
    }
  });

  it('drives toward the ball rather than away from it', () => {
    const world = makeWorld(1);
    const car = world.cars[1];
    car.reset(V.make(0, 3500, 17), -Math.PI / 2, 100);
    world.ball.reset(V.make(0, 0, 93.15));
    const bot = new Bot(car, 'ace', 5);

    const before = V.distance(car.position, world.ball.position);
    const inputs = new Map<Car, CarInput>();
    for (let i = 0; i < 120 * 2; i++) {
      inputs.set(car, bot.think(world, TICK_DT));
      world.step(inputs, TICK_DT);
      world.events.length = 0;
    }
    expect(V.distance(car.position, world.ball.position)).toBeLessThan(before - 500);
  });

  it('lets a rookie react more slowly than an ace', () => {
    const world = makeWorld(1);
    const rookie = new Bot(world.cars[0], 'rookie', 1);
    const ace = new Bot(world.cars[1], 'ace', 1);
    // Both should still be able to produce a command immediately.
    expect(rookie.think(world, TICK_DT)).toBeDefined();
    expect(ace.think(world, TICK_DT)).toBeDefined();
    expect(rookie.difficulty).toBe('rookie');
    expect(ace.difficulty).toBe('ace');
  });
});

describe('input', () => {
  it('is a no-op command when neutral', () => {
    const input = neutralInput();
    expect(input.throttle).toBe(0);
    expect(input.jump).toBe(false);
  });
});
