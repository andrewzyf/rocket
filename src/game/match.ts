/**
 * Match rules: kickoff countdown, clock, scoring, celebration, overtime.
 *
 * The clock detail worth getting right: time does not simply stop at 0:00. If
 * the ball is still in flight the period keeps running until it settles, so a
 * shot taken on the buzzer still counts.
 */

import {
  DEFAULT_MATCH_DURATION,
  GOAL_CELEBRATION,
  KICKOFF_COUNTDOWN,
  TEAM_BLUE,
  TEAM_ORANGE,
} from '../core/constants';
import type { World } from '../physics/world';

export type MatchPhase = 'warmup' | 'countdown' | 'playing' | 'goal' | 'over';

export interface MatchOptions {
  duration: number;
  overtime: boolean;
}

export class Match {
  phase: MatchPhase = 'warmup';
  /** Seconds remaining; counts up instead once overtime starts. */
  clock: number;
  score: [number, number] = [0, 0];
  overtime = false;
  /** Team that won, once the match is over. */
  winner: number | null = null;

  /** Seconds left in the countdown or celebration, whichever is running. */
  phaseTimer = 0;
  /** Set the moment a goal is scored, for the HUD banner and replay. */
  lastGoal: { team: number; scorerName: string | null } | null = null;

  private readonly options: MatchOptions;
  /**
   * True once the clock has run out but play continues because the ball is
   * still live. The period ends the moment the ball settles or is scored.
   */
  private inStoppage = false;

  constructor(private readonly world: World, options?: Partial<MatchOptions>) {
    this.options = {
      duration: options?.duration ?? DEFAULT_MATCH_DURATION,
      overtime: options?.overtime ?? true,
    };
    this.clock = this.options.duration;
  }

  get duration(): number {
    return this.options.duration;
  }

  get isStoppage(): boolean {
    return this.inStoppage;
  }

  start(): void {
    this.score = [0, 0];
    this.clock = this.options.duration;
    this.overtime = false;
    this.winner = null;
    this.lastGoal = null;
    this.inStoppage = false;
    this.beginCountdown();
  }

  private beginCountdown(): void {
    this.world.kickoff();
    this.world.frozen = true;
    this.phase = 'countdown';
    this.phaseTimer = KICKOFF_COUNTDOWN;
  }

  /** Called once per rendered frame, after the world has been stepped. */
  update(dt: number, scorerName?: (team: number) => string | null): void {
    switch (this.phase) {
      case 'countdown':
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) {
          this.phaseTimer = 0;
          this.world.frozen = false;
          this.phase = 'playing';
        }
        break;

      case 'playing':
        this.tickClock(dt);
        if (this.world.goalScored) {
          const { team, scorer } = this.world.goalScored;
          this.score[team]++;
          this.lastGoal = {
            team,
            scorerName: scorer ? (scorerName?.(team) ?? null) : null,
          };
          this.phase = 'goal';
          this.phaseTimer = GOAL_CELEBRATION;
          this.world.frozen = true;
          this.inStoppage = false;
        }
        break;

      case 'goal':
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) {
          if (this.overtime) {
            this.finish();
          } else if (this.clock <= 0) {
            this.endRegulation();
          } else {
            this.beginCountdown();
          }
        }
        break;

      case 'warmup':
      case 'over':
        break;
    }
  }

  /**
   * Regulation clock. Once it hits zero the period only actually ends when the
   * ball comes to rest on the floor -- a shot in the air keeps play alive.
   */
  private tickClock(dt: number): void {
    if (this.overtime) {
      this.clock += dt;
      return;
    }

    if (this.clock > 0) {
      this.clock = Math.max(0, this.clock - dt);
      if (this.clock === 0) this.inStoppage = true;
      return;
    }

    if (this.inStoppage && this.ballIsDead()) {
      this.inStoppage = false;
      this.endRegulation();
    }
  }

  /** The ball counts as dead once it is resting on the floor. */
  private ballIsDead(): boolean {
    const ball = this.world.ball;
    return ball.position.z < 120 && Math.abs(ball.velocity.z) < 60 && ball.speed < 320;
  }

  private endRegulation(): void {
    if (this.score[TEAM_BLUE] === this.score[TEAM_ORANGE] && this.options.overtime) {
      this.overtime = true;
      this.clock = 0;
      this.beginCountdown();
      return;
    }
    this.finish();
  }

  private finish(): void {
    this.phase = 'over';
    this.world.frozen = true;
    this.winner =
      this.score[TEAM_BLUE] === this.score[TEAM_ORANGE]
        ? null
        : this.score[TEAM_BLUE] > this.score[TEAM_ORANGE]
          ? TEAM_BLUE
          : TEAM_ORANGE;
  }

  /** `M:SS`, with overtime counting up from 0:00. */
  formatClock(): string {
    const total = Math.max(0, Math.floor(this.clock));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}
