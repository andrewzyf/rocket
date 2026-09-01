import { describe, expect, it } from 'vitest';
import { field } from '../src/physics/field';
import { V } from '../src/core/math';
import {
  BACK_WALL_Y,
  BALL_COLLISION_RADIUS,
  CEILING_Z,
  GOAL_CENTER_TO_POST,
  SIDE_WALL_X,
} from '../src/core/constants';

describe('arena field', () => {
  it('measures the floor from mid-air', () => {
    const q = field.query(V.make(0, 0, 100));
    expect(q.dist).toBeCloseTo(100, 3);
    expect(q.normal.z).toBeCloseTo(1, 6);
  });

  it('measures the ceiling from just below it', () => {
    const q = field.query(V.make(0, 0, CEILING_Z - 80));
    expect(q.dist).toBeCloseTo(80, 3);
    expect(q.normal.z).toBeCloseTo(-1, 6);
  });

  it('measures the side wall', () => {
    const q = field.query(V.make(SIDE_WALL_X - 96, 0, 1000));
    expect(q.dist).toBeCloseTo(96, 3);
    expect(q.normal.x).toBeCloseTo(-1, 6);
  });

  it('rounds the floor-to-wall junction instead of leaving a sharp corner', () => {
    // 100 uu from the wall and 100 uu up: inside the 256 uu fillet on both,
    // so the surface normal should be a 45-degree ramp, not axis-aligned.
    const q = field.query(V.make(SIDE_WALL_X - 100, 0, 100));
    expect(q.normal.x).toBeCloseTo(-Math.SQRT1_2, 3);
    expect(q.normal.z).toBeCloseTo(Math.SQRT1_2, 3);
    // Distance is smaller than either plane distance -- the fillet bulges inward.
    expect(q.dist).toBeGreaterThan(0);
    expect(q.dist).toBeLessThan(100);
  });

  it('cuts the corners at |x| + |y| = 8064', () => {
    // A point beyond the corner plane must read as outside.
    expect(field.query(V.make(3900, 4400, 1000)).dist).toBeLessThan(0);
    expect(field.query(V.make(3000, 4000, 1000)).dist).toBeGreaterThan(0);
  });

  it('opens a hole in the back wall at the goal mouth', () => {
    // z = 400 keeps us clear of the 256 uu floor-to-wall ramp, so the only
    // nearby surface is the back wall itself.
    const inMouth = V.make(0, BACK_WALL_Y - 40, 400);
    const besideMouth = V.make(GOAL_CENTER_TO_POST + 400, BACK_WALL_Y - 40, 400);
    // Beside the mouth the wall is solid and close.
    expect(field.query(besideMouth).dist).toBeCloseTo(40, 1);
    // In the mouth the wall is absent, so the floor 400 uu below is nearest.
    expect(field.query(inMouth).dist).toBeCloseTo(400, 1);
  });

  it('contains the ball inside the goal recess', () => {
    const insideGoal = V.make(0, BACK_WALL_Y + 500, 200);
    const q = field.query(insideGoal);
    expect(q.dist).toBeGreaterThan(0);
    expect(q.dist).toBeLessThan(400);
  });

  it('rests a ball sphere exactly on its collision radius', () => {
    const resting = V.make(0, 0, BALL_COLLISION_RADIUS);
    expect(field.collideSphere(resting, BALL_COLLISION_RADIUS)).toBeNull();
    const sunk = V.make(0, 0, BALL_COLLISION_RADIUS - 5);
    const hit = field.collideSphere(sunk, BALL_COLLISION_RADIUS);
    expect(hit).not.toBeNull();
    expect(hit!.depth).toBeCloseTo(5, 3);
    expect(hit!.normal.z).toBeCloseTo(1, 6);
  });

  it('raycasts down to the floor', () => {
    const hit = field.raycast(V.make(0, 0, 500), V.make(0, 0, -1), 1000);
    expect(hit).not.toBeNull();
    expect(hit!.dist).toBeCloseTo(500, 0);
    expect(hit!.normal.z).toBeCloseTo(1, 3);
  });

  it('pings the ball off a goal post', () => {
    const atPost = V.make(GOAL_CENTER_TO_POST, BACK_WALL_Y, 300);
    const hit = field.collideSphere(V.add(atPost, V.make(60, 0, 0)), BALL_COLLISION_RADIUS);
    expect(hit).not.toBeNull();
  });
});
