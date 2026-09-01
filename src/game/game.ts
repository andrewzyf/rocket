/**
 * Game orchestration: owns the renderer, the simulation, and the flow between
 * menu, match and result.
 *
 * The loop runs physics at a fixed 120 Hz from an accumulator and renders
 * whenever the browser asks. Because the tick rate is at or above every common
 * display rate, the renderer just draws the latest state -- worst case one tick
 * (8.3 ms) of latency, which is cheaper than maintaining an interpolated copy
 * of every body.
 */

import * as THREE from 'three';
import {
  BALL_COLLISION_RADIUS,
  BODY_TYPES,
  DEFAULT_BODY,
  DRIVE_SPEED,
  MAX_TICKS_PER_FRAME,
  SUPERSONIC_THRESHOLD,
  TEAM_COLORS,
  TEAM_NAMES,
  TICK_DT,
} from '../core/constants';
import { V, clamp } from '../core/math';
import { InputManager, toCarInput } from '../core/input';
import { Car, type CarInput } from '../physics/car';
import { World, type WorldEvent } from '../physics/world';
import { Bot } from '../ai/bot';
import { buildArena, type Arena } from '../scenes/arena';
import { Particles } from '../scenes/particles';
import { CarEntity } from '../entities/carEntity';
import { BallEntity } from '../entities/ballEntity';
import { ChaseCamera } from './camera';
import { Match } from './match';
import { AudioEngine } from '../audio/audio';
import { Hud } from '../ui/hud';
import { DebugOverlay } from '../ui/debug';
import { Menu, PAINT_SWATCHES, type GameConfig } from '../ui/menu';

const BOT_NAMES = ['VOLT', 'ASH', 'RIVET', 'KESTREL', 'NOVA', 'PYLON', 'QUARTZ'];

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly chase = new ChaseCamera();
  private readonly particles = new Particles();
  private readonly arena: Arena;

  private readonly world = new World();
  private match: Match;
  private readonly input: InputManager;
  private readonly audio = new AudioEngine();

  private readonly hud = new Hud();
  private readonly debug = new DebugOverlay();
  private readonly menu: Menu;

  private player!: Car;
  private readonly bots: Bot[] = [];
  private readonly entities: CarEntity[] = [];
  private ballEntity!: BallEntity;

  private accumulator = 0;
  private lastFrame = performance.now();
  private running = false;
  private paused = false;
  private lastCountdownCall = -1;
  private replayTimer = 0;
  private ticksLastFrame = 0;

  private readonly config: GameConfig = {
    teamSize: 2,
    difficulty: 'pro',
    duration: 300,
    bodyId: DEFAULT_BODY.id,
    paint: PAINT_SWATCHES[0],
  };

  private readonly audioState = { volume: 0.7, audioEnabled: true };

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;

    this.camera = new THREE.PerspectiveCamera(110, 1, 20, 32000);
    // Physics is Z-up and so is the scene, so the camera has to agree.
    this.camera.up.set(0, 0, 1);

    this.scene.fog = new THREE.Fog(0x2a2350, 11000, 30000);
    this.arena = buildArena(this.scene);
    this.scene.add(this.particles.points);

    this.match = new Match(this.world, { duration: this.config.duration });

    this.input = new InputManager(window);
    this.menu = new Menu(
      this.config,
      this.chase.settings,
      this.input,
      this.audio,
      {
        onStart: () => void this.startMatch(),
        onResume: () => this.setPaused(false),
        onQuitToMenu: () => this.quitToMenu(),
        onRestart: () => void this.startMatch(),
        onConfigChanged: () => this.applyConfig(),
      },
      this.audioState,
    );

    ui.append(this.hud.root, this.debug.root, this.menu.root);
    this.hud.setVisible(false);

    // Exposed so the scene can be inspected from the browser console.
    (window as unknown as { nitrobowl: unknown }).nitrobowl = this;

    this.bindHotkeys();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.buildTeams();
    this.world.kickoff();
  }

  // ------------------------------------------------------------------- setup

  private bindHotkeys(): void {
    this.input.on('pause', () => {
      if (!this.running) return;
      this.setPaused(!this.paused);
    });
    this.input.on('ballCam', () => {
      if (!this.running || this.paused) return;
      const on = this.chase.toggleBallCam();
      this.hud.showBanner(on ? 'BALL CAM' : 'CAR CAM');
      window.setTimeout(() => this.hud.hideBanner(), 700);
    });
    window.addEventListener('keydown', (event) => {
      if (event.code === 'F3') {
        event.preventDefault();
        this.debug.toggle();
      }
    });
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  /** Rebuild the roster whenever team size or difficulty changes. */
  private buildTeams(): void {
    for (const entity of this.entities) entity.dispose();
    this.entities.length = 0;
    this.bots.length = 0;
    this.world.clearCars();
    this.botInputs.clear();

    const body = BODY_TYPES.find((b) => b.id === this.config.bodyId) ?? DEFAULT_BODY;
    const size = this.config.teamSize;

    for (let team = 0; team < 2; team++) {
      for (let i = 0; i < size; i++) {
        const car = new Car(team, i, body);
        this.world.addCar(car);

        const isPlayer = team === 0 && i === 0;
        if (isPlayer) this.player = car;
        else this.bots.push(new Bot(car, this.config.difficulty, team * 31 + i + 1));

        const entity = new CarEntity(
          car,
          this.particles,
          isPlayer ? this.config.paint : TEAM_COLORS[team],
        );
        this.scene.add(entity.group);
        this.entities.push(entity);
      }
    }

    if (!this.ballEntity) {
      this.ballEntity = new BallEntity(this.world.ball);
      this.ballEntity.addTo(this.scene);
    }
    this.chase.reset();
  }

  private applyConfig(): void {
    if (this.running) return;
    this.buildTeams();
    this.world.kickoff();
  }

  // -------------------------------------------------------------- match flow

  private async startMatch(): Promise<void> {
    await this.audio.resume();
    this.buildTeams();
    this.match = new Match(this.world, { duration: this.config.duration });
    this.match.start();
    this.particles.clear();
    this.chase.reset();
    this.chase.cinematic = null;
    this.running = true;
    this.paused = false;
    this.lastCountdownCall = -1;
    this.menu.show(null);
    this.hud.setVisible(true);
    this.hud.hideBanner();
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.menu.show(paused ? 'pause' : null);
    this.hud.setVisible(!paused);
  }

  private quitToMenu(): void {
    this.running = false;
    this.paused = false;
    this.hud.setVisible(false);
    this.chase.cinematic = null;
    this.buildTeams();
    this.world.kickoff();
    this.menu.show('main');
  }

  start(): void {
    this.lastFrame = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // -------------------------------------------------------------------- loop

  private frame(): void {
    const now = performance.now();
    const frameMs = now - this.lastFrame;
    this.lastFrame = now;
    // Clamp so a backgrounded tab doesn't come back and simulate ten seconds
    // of physics in one frame.
    const dt = Math.min(frameMs / 1000, 0.25);

    const raw = this.input.poll();

    if (this.running && !this.paused) {
      this.simulate(dt, raw);
    } else if (!this.running) {
      // Idle orbit behind the menu. A paused match keeps the camera exactly
      // where it was -- swinging away to an orbit loses the player's read on
      // the play they are about to resume.
      this.idleCamera(dt);
    }

    this.particles.update(dt);
    for (const entity of this.entities) {
      entity.update(dt, entity.car === this.player ? raw.boost : this.botBoosting(entity.car));
    }
    this.ballEntity.update(dt);
    this.animatePads(dt);

    this.debug.update(this.player, this.world.ball, frameMs, this.ticksLastFrame);
    this.renderer.render(this.scene, this.camera);
  }

  private botInputs = new Map<Car, CarInput>();

  private botBoosting(car: Car): boolean {
    return this.botInputs.get(car)?.boost ?? false;
  }

  private simulate(dt: number, raw: ReturnType<InputManager['poll']>): void {
    const inputs = new Map<Car, CarInput>();

    this.accumulator += dt;
    let ticks = 0;
    while (this.accumulator >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
      // Ground/air context is re-read each tick, so a landing mid-frame swaps
      // the control scheme at the right moment.
      inputs.set(this.player, toCarInput(raw, this.player.onGround));
      for (const bot of this.bots) {
        const command = bot.think(this.world, TICK_DT);
        inputs.set(bot.car, command);
        this.botInputs.set(bot.car, command);
      }

      this.world.step(inputs, TICK_DT);
      this.accumulator -= TICK_DT;
      ticks++;
    }
    this.ticksLastFrame = ticks;
    if (ticks === MAX_TICKS_PER_FRAME) this.accumulator = 0;

    this.consumeEvents();
    this.match.update(dt, (team) => this.scorerName(team));
    this.updateHud(dt);
    this.updateCamera(dt);
    this.updateAudio();
    this.checkMatchOver();
  }

  private scorerName(team: number): string {
    const scorer = this.world.goalScored?.scorer;
    if (!scorer) return TEAM_NAMES[team];
    if (scorer === this.player) return 'YOU';
    const index = this.world.cars.indexOf(scorer);
    return BOT_NAMES[index % BOT_NAMES.length];
  }

  /** Turn simulation events into sound and particles. */
  private consumeEvents(): void {
    for (const event of this.world.events) this.handleEvent(event);
    this.world.events.length = 0;
  }

  private handleEvent(event: WorldEvent): void {
    switch (event.type) {
      case 'ball-touch': {
        this.audio.ballHit(event.impulse);
        const color = TEAM_COLORS[event.car.team];
        this.particles.burst(event.point, Math.min(26, 6 + event.impulse / 2500), 380, {
          life: 0.3,
          size: 22,
          endScale: 0,
          color,
          drag: 0.05,
        });
        break;
      }
      case 'ball-bounce':
        this.audio.ballBounce(event.impulse);
        break;
      case 'boost-pickup': {
        this.audio.boostPickup(event.big);
        this.particles.burst(event.position, event.big ? 30 : 14, event.big ? 420 : 240, {
          life: 0.45,
          size: event.big ? 30 : 20,
          endScale: 0,
          color: event.big ? 0xffd166 : 0xffb020,
          drag: 0.1,
        });
        break;
      }
      case 'jump':
        if (event.car === this.player) this.audio.jump();
        break;
      case 'dodge':
        if (event.car === this.player) this.audio.dodge();
        break;
      case 'land':
        if (event.car === this.player) this.audio.land(event.impact);
        break;
      case 'bump':
        this.audio.bump(event.impulse);
        break;
      case 'demolition': {
        this.audio.explosion();
        this.particles.burst(event.position, 160, 1100, {
          life: 0.85,
          size: 44,
          endScale: 0,
          color: TEAM_COLORS[event.victim.team],
          gravity: 300,
          drag: 0.35,
        });
        this.particles.burst(event.position, 60, 600, {
          life: 0.5,
          size: 70,
          endScale: 0,
          color: 0xffffff,
          drag: 0.2,
        });
        break;
      }
      case 'goal':
        this.celebrateGoal(event.team);
        break;
    }
  }

  private celebrateGoal(team: number): void {
    this.audio.goal();
    this.audio.setCrowdExcitement(1);

    const at = V.clone(this.world.ball.position);
    this.particles.burst(at, 320, 1600, {
      life: 1.3,
      size: 52,
      endScale: 0,
      color: TEAM_COLORS[team],
      gravity: 240,
      drag: 0.45,
    });
    this.particles.burst(at, 120, 900, {
      life: 0.8,
      size: 90,
      endScale: 0,
      color: 0xffffff,
      drag: 0.3,
    });

    this.ballEntity.setVisible(false);
    this.replayTimer = 3.0;

    // Slow orbit in place of the live chase cam. The centre is pulled back
    // toward midfield: orbiting the ball where it actually crossed the line
    // puts the camera inside the net, looking at the back of the frame.
    const towardField = at.y > 0 ? -1 : 1;
    this.chase.cinematic = {
      center: V.make(at.x * 0.4, at.y + towardField * 700, Math.max(at.z, 260)),
      radius: 1500,
      height: 700,
      angle: Math.atan2(at.y, at.x) + Math.PI,
    };

    // Flash the scoring goal's frame.
    const ring = this.arena.goalRings[at.y > 0 ? 1 : 0];
    ring.traverse((node) => {
      const mesh = node as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (material?.emissiveIntensity !== undefined) material.emissiveIntensity = 5;
    });
    window.setTimeout(() => {
      ring.traverse((node) => {
        const mesh = node as THREE.Mesh;
        const material = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (material?.emissiveIntensity !== undefined) material.emissiveIntensity = 1.4;
      });
    }, 900);
  }

  private checkMatchOver(): void {
    if (this.match.phase !== 'over' || !this.running) return;
    this.running = false;
    this.hud.setVisible(false);
    this.chase.cinematic = null;
    this.audio.whistle();

    const [blue, orange] = this.match.score;
    const winner = this.match.winner;
    const headline = winner === null ? 'Draw' : winner === 0 ? 'Victory' : 'Defeat';
    this.menu.showResult(headline, `${TEAM_NAMES[0]} ${blue} — ${orange} ${TEAM_NAMES[1]}`, winner);
  }

  // ------------------------------------------------------------------ visuals

  private updateHud(dt: number): void {
    this.hud.setScore(this.match.score[0], this.match.score[1]);
    this.hud.setClock(this.match.formatClock(), this.match.overtime, this.match.isStoppage);
    this.hud.setBoost(this.player.boost);
    this.hud.setSpeed(this.player.speed, this.player.supersonic);

    if (this.match.phase === 'countdown') {
      const remaining = Math.ceil(this.match.phaseTimer);
      this.hud.showCountdown(remaining > 0 ? String(remaining) : 'GO');
      if (remaining !== this.lastCountdownCall) {
        this.lastCountdownCall = remaining;
        this.audio.countdownTick(remaining <= 0);
      }
      this.hud.hideBanner();
    } else {
      this.hud.showCountdown(null);
      this.lastCountdownCall = -1;
    }

    if (this.match.phase === 'goal' && this.match.lastGoal) {
      const { team, scorerName } = this.match.lastGoal;
      this.hud.showBanner('GOAL', scorerName ? `${scorerName} scores` : TEAM_NAMES[team], team);
    } else if (this.match.phase !== 'countdown') {
      this.hud.hideBanner();
    }

    if (this.replayTimer > 0) {
      this.replayTimer -= dt;
      if (this.replayTimer <= 0) {
        this.chase.cinematic = null;
        this.ballEntity.setVisible(true);
      }
    }
  }

  private updateCamera(dt: number): void {
    // Slow motion during the goal replay, purely a presentation effect.
    const scaled = this.chase.cinematic ? dt * 0.45 : dt;
    this.chase.update(this.camera, this.player, this.world.ball, scaled);
  }

  private updateAudio(): void {
    const car = this.player;
    this.audio.updateEngine(
      clamp(car.speed / SUPERSONIC_THRESHOLD, 0, 1.2),
      Math.abs(car.forwardSpeed) / DRIVE_SPEED,
      car.boost > 0 && this.input.isDown('boost'),
      !car.onGround,
    );

    // Crowd noise rises as the ball nears either net.
    const ballY = Math.abs(this.world.ball.position.y);
    const excitement = clamp((ballY - 2200) / 2800, 0, 1);
    this.audio.setCrowdExcitement(excitement * 0.8);
  }

  /** Boost pads bob and spin; picked-up pads shrink away and grow back. */
  private animatePads(dt: number): void {
    const time = performance.now() / 1000;
    for (let i = 0; i < this.arena.pads.length; i++) {
      const visual = this.arena.pads[i];
      const state = this.world.pads[i];
      const target = state.active ? 1 : 0;
      const current = visual.glow.scale.x;
      const next = current + (target - current) * Math.min(1, dt * 9);
      visual.glow.scale.set(next, next, next);
      visual.glow.visible = next > 0.02;
      visual.glow.rotation.z = time * (visual.big ? 0.8 : 1.4) + i;
      visual.glow.position.z = (visual.big ? 100 : 20) + Math.sin(time * 2 + i) * 6 * next;
    }
  }

  /** Gentle orbit of the arena while a menu is open. */
  private idleCamera(dt: number): void {
    const time = performance.now() / 9000;
    // Stay well inside the walls: outside the shell we would be looking at
    // back-faced geometry and see nothing.
    const radius = 3000;
    this.camera.position.set(
      Math.cos(time) * radius,
      Math.sin(time) * radius * 1.25,
      760 + Math.sin(time * 0.7) * 180,
    );
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(0, 0, BALL_COLLISION_RADIUS + 220);
    void dt;
  }
}
