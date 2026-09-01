/**
 * Input: keyboard plus Gamepad API, with rebindable keys.
 *
 * The important mapping detail is that the stick axes change meaning when the
 * wheels leave the ground. On the ground, left/right is steering. In the air it
 * is yaw -- unless air roll is held, in which case it becomes roll. Forward and
 * back become pitch. Reproducing that context switch is what makes the aerial
 * controls feel right on a keyboard at all.
 */

export type Action =
  | 'throttle'
  | 'brake'
  | 'left'
  | 'right'
  | 'jump'
  | 'boost'
  | 'powerslide'
  | 'airRoll'
  | 'airRollLeft'
  | 'airRollRight'
  | 'ballCam'
  | 'pause'
  | 'scoreboard';

export type Bindings = Record<Action, string[]>;

export const DEFAULT_BINDINGS: Bindings = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  boost: ['ShiftLeft', 'Mouse2'],
  powerslide: ['ControlLeft', 'Mouse0'],
  airRoll: ['AltLeft'],
  airRollLeft: ['KeyQ'],
  airRollRight: ['KeyE'],
  ballCam: ['KeyC'],
  pause: ['Escape'],
  scoreboard: ['Tab'],
};

export const ACTION_LABELS: Record<Action, string> = {
  throttle: 'Accelerate',
  brake: 'Reverse / Brake',
  left: 'Steer / Yaw left',
  right: 'Steer / Yaw right',
  jump: 'Jump / Flip',
  boost: 'Boost',
  powerslide: 'Powerslide',
  airRoll: 'Air roll (hold)',
  airRollLeft: 'Air roll left',
  airRollRight: 'Air roll right',
  ballCam: 'Toggle ball cam',
  pause: 'Pause',
  scoreboard: 'Scoreboard',
};

const STORAGE_KEY = 'nitrobowl.bindings.v1';

export function loadBindings(): Bindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_BINDINGS);
    const parsed = JSON.parse(raw) as Partial<Bindings>;
    const merged = structuredClone(DEFAULT_BINDINGS);
    for (const key of Object.keys(merged) as Action[]) {
      if (Array.isArray(parsed[key]) && parsed[key]!.length) merged[key] = parsed[key]!;
    }
    return merged;
  } catch {
    return structuredClone(DEFAULT_BINDINGS);
  }
}

export function saveBindings(bindings: Bindings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // Private browsing or storage disabled: bindings just won't persist.
  }
}

/** Human-readable name for a key code or mouse button token. */
export function describeCode(code: string): string {
  if (code.startsWith('Mouse')) {
    const n = Number(code.slice(5));
    return ['Left click', 'Middle click', 'Right click'][n] ?? `Mouse ${n}`;
  }
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `${code.slice(5)} arrow`;
  const pretty: Record<string, string> = {
    Space: 'Space',
    ShiftLeft: 'Left shift',
    ShiftRight: 'Right shift',
    ControlLeft: 'Left ctrl',
    ControlRight: 'Right ctrl',
    AltLeft: 'Left alt',
    AltRight: 'Right alt',
    Escape: 'Esc',
    Tab: 'Tab',
  };
  return pretty[code] ?? code;
}

export interface RawState {
  throttle: number;
  brake: number;
  steer: number;
  pitch: number;
  jump: boolean;
  boost: boolean;
  powerslide: boolean;
  airRoll: boolean;
  airRollLeft: boolean;
  airRollRight: boolean;
}

export class InputManager {
  bindings: Bindings;
  /** Set while the rebinding UI is capturing the next key press. */
  capture: ((code: string) => void) | null = null;
  gamepadConnected = false;

  private readonly held = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();
  private readonly listeners = new Map<Action, Array<() => void>>();

  constructor(private readonly target: HTMLElement | Window = window) {
    this.bindings = loadBindings();
    this.attach();
  }

  private attach(): void {
    const el = this.target as Window;
    el.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (e.repeat) return;
      if (this.capture) {
        e.preventDefault();
        const handler = this.capture;
        this.capture = null;
        handler(e.code);
        return;
      }
      // Don't fight the browser while the user is typing in a field.
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.press(e.code);
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    el.addEventListener('keyup', (event) => this.release((event as KeyboardEvent).code));
    el.addEventListener('blur', () => this.held.clear());

    el.addEventListener('mousedown', (event) => {
      const e = event as MouseEvent;
      if (this.capture) {
        e.preventDefault();
        const handler = this.capture;
        this.capture = null;
        handler(`Mouse${e.button}`);
        return;
      }
      this.press(`Mouse${e.button}`);
    });
    el.addEventListener('mouseup', (event) => this.release(`Mouse${(event as MouseEvent).button}`));
    el.addEventListener('contextmenu', (event) => event.preventDefault());

    el.addEventListener('gamepadconnected', () => {
      this.gamepadConnected = true;
    });
    el.addEventListener('gamepaddisconnected', () => {
      this.gamepadConnected = false;
    });
  }

  private press(code: string): void {
    if (!this.held.has(code)) this.pressedThisFrame.add(code);
    this.held.add(code);
  }

  private release(code: string): void {
    this.held.delete(code);
  }

  /** Register a one-shot handler that fires on the rising edge of an action. */
  on(action: Action, handler: () => void): void {
    const list = this.listeners.get(action) ?? [];
    list.push(handler);
    this.listeners.set(action, list);
  }

  isDown(action: Action): boolean {
    return this.bindings[action].some((code) => this.held.has(code));
  }

  private wasPressed(action: Action): boolean {
    return this.bindings[action].some((code) => this.pressedThisFrame.has(code));
  }

  rebind(action: Action, index: number, code: string): void {
    const list = [...this.bindings[action]];
    list[index] = code;
    this.bindings[action] = list;
    saveBindings(this.bindings);
  }

  resetBindings(): void {
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    saveBindings(this.bindings);
  }

  /** Call once per frame, before reading state. */
  poll(): RawState {
    for (const [action, handlers] of this.listeners) {
      if (this.wasPressed(action)) for (const handler of handlers) handler();
    }
    this.pressedThisFrame.clear();

    const state: RawState = {
      throttle: this.isDown('throttle') ? 1 : 0,
      brake: this.isDown('brake') ? 1 : 0,
      steer: (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0),
      pitch: 0,
      jump: this.isDown('jump'),
      boost: this.isDown('boost'),
      powerslide: this.isDown('powerslide'),
      airRoll: this.isDown('airRoll'),
      airRollLeft: this.isDown('airRollLeft'),
      airRollRight: this.isDown('airRollRight'),
    };
    // On a keyboard, accelerate/reverse double as pitch while airborne.
    state.pitch = state.brake - state.throttle;

    this.mergeGamepad(state);
    return state;
  }

  /** Standard-layout gamepad, blended over the keyboard state. */
  private mergeGamepad(state: RawState): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    if (!pad) return;
    this.gamepadConnected = true;

    const deadzone = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
    const axisX = deadzone(pad.axes[0] ?? 0);
    const axisY = deadzone(pad.axes[1] ?? 0);
    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;

    if (rt > 0.05) state.throttle = Math.max(state.throttle, rt);
    if (lt > 0.05) state.brake = Math.max(state.brake, lt);
    if (axisX !== 0) state.steer = axisX;
    // Stick forward (negative Y) should pitch the nose down.
    if (axisY !== 0) state.pitch = axisY;

    state.jump ||= pad.buttons[0]?.pressed ?? false;
    state.boost ||= (pad.buttons[1]?.pressed ?? false) || (pad.buttons[5]?.pressed ?? false);
    state.powerslide ||= (pad.buttons[2]?.pressed ?? false) || (pad.buttons[4]?.pressed ?? false);
    state.airRoll ||= pad.buttons[2]?.pressed ?? false;
  }
}

/**
 * Turn raw input into a car command, applying the ground/air context switch.
 * `onGround` decides whether the horizontal axis steers or yaws, and whether
 * powerslide means handbrake or air roll.
 */
export function toCarInput(raw: RawState, onGround: boolean) {
  const rollHeld = raw.airRoll || raw.airRollLeft || raw.airRollRight;
  const rollAxis = raw.airRollLeft ? -1 : raw.airRollRight ? 1 : 0;

  if (onGround) {
    return {
      throttle: raw.throttle - raw.brake,
      steer: raw.steer,
      pitch: 0,
      yaw: 0,
      roll: 0,
      jump: raw.jump,
      boost: raw.boost,
      handbrake: raw.powerslide,
    };
  }

  // Airborne: the horizontal axis becomes roll while air roll is held, yaw
  // otherwise. Pitch is always the vertical axis.
  const horizontal = raw.steer;
  const yaw = raw.airRoll ? 0 : horizontal;
  const roll = raw.airRoll ? horizontal : rollAxis;

  return {
    throttle: raw.throttle - raw.brake,
    // Steering is still fed through so that a dodge on the frame you land
    // reads the same direction the player was holding.
    steer: raw.steer,
    pitch: raw.pitch,
    yaw,
    roll,
    jump: raw.jump,
    boost: raw.boost,
    handbrake: rollHeld,
  };
}
