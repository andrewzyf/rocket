/**
 * Menus: main, settings (camera / audio / controls), pause, and post-match.
 *
 * Built as DOM so the browser handles focus, scrolling and accessibility. The
 * menu owns no game state -- it reads and writes a config object the game hands
 * it, and reports button presses through callbacks.
 */

import { BODY_TYPES, MATCH_DURATIONS, TEAM_NAMES } from '../core/constants';
import { ACTION_LABELS, describeCode, type Action, type InputManager } from '../core/input';
import type { CameraSettings } from '../game/camera';
import type { Difficulty } from '../ai/bot';

export interface GameConfig {
  teamSize: 1 | 2 | 3;
  difficulty: Difficulty;
  duration: number;
  bodyId: string;
  paint: number;
}

export const PAINT_SWATCHES = [
  0x18e0ff, 0xff2fa4, 0xf5f7ff, 0x24304f, 0x35e08a, 0xffb020, 0xa46bff, 0xff5b4a,
];

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  rookie: 'Rookie',
  pro: 'Pro',
  ace: 'Ace',
};

export type Screen = 'main' | 'settings' | 'controls' | 'pause' | 'result' | null;

export interface MenuCallbacks {
  onStart: () => void;
  onResume: () => void;
  onQuitToMenu: () => void;
  onRestart: () => void;
  onConfigChanged: () => void;
}

export class Menu {
  readonly root = document.createElement('div');
  screen: Screen = 'main';

  private result: { headline: string; sub: string; team: number | null } | null = null;

  constructor(
    readonly config: GameConfig,
    private readonly camera: CameraSettings,
    private readonly input: InputManager,
    private readonly audio: { setVolume(v: number): void; setEnabled(e: boolean): void },
    private readonly callbacks: MenuCallbacks,
    private readonly state: { volume: number; audioEnabled: boolean },
  ) {
    this.root.className = 'overlay clickable';
    this.render();
  }

  show(screen: Screen): void {
    this.screen = screen;
    this.render();
  }

  showResult(headline: string, sub: string, team: number | null): void {
    this.result = { headline, sub, team };
    this.show('result');
  }

  get isOpen(): boolean {
    return this.screen !== null;
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    if (this.screen === null) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';
    this.root.replaceChildren(this.buildPanel());
  }

  private buildPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'panel';
    switch (this.screen) {
      case 'main':
        this.buildMain(panel);
        break;
      case 'settings':
        this.buildSettings(panel);
        break;
      case 'controls':
        this.buildControls(panel);
        break;
      case 'pause':
        this.buildPause(panel);
        break;
      case 'result':
        this.buildResult(panel);
        break;
    }
    return panel;
  }

  private heading(panel: HTMLElement, title: string, tagline?: string): void {
    const h1 = document.createElement('h1');
    h1.textContent = title;
    panel.append(h1);
    if (tagline) {
      const p = document.createElement('p');
      p.className = 'tagline';
      p.textContent = tagline;
      panel.append(p);
    }
  }

  private section(panel: HTMLElement, title: string): void {
    const h2 = document.createElement('h2');
    h2.textContent = title;
    panel.append(h2);
  }

  private choiceRow<T>(
    panel: HTMLElement,
    label: string,
    options: Array<{ value: T; label: string; title?: string }>,
    current: T,
    onPick: (value: T) => void,
  ): void {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('label');
    name.textContent = label;
    const choices = document.createElement('div');
    choices.className = 'choices';

    for (const option of options) {
      const button = document.createElement('button');
      button.textContent = option.label;
      if (option.title) button.title = option.title;
      if (option.value === current) button.classList.add('selected');
      button.addEventListener('click', () => {
        onPick(option.value);
        this.callbacks.onConfigChanged();
        this.render();
      });
      choices.append(button);
    }

    row.append(name, choices);
    panel.append(row);
  }

  private sliderRow(
    panel: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    format: (v: number) => string,
    onInput: (value: number) => void,
  ): void {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('label');
    name.textContent = label;

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '12px';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);

    const readout = document.createElement('span');
    readout.className = 'value';
    readout.textContent = format(value);

    slider.addEventListener('input', () => {
      const next = Number(slider.value);
      readout.textContent = format(next);
      onInput(next);
    });

    right.append(slider, readout);
    row.append(name, right);
    panel.append(row);
  }

  private button(panel: HTMLElement, label: string, onClick: () => void, primary = false): void {
    const button = document.createElement('button');
    button.textContent = label;
    if (primary) button.classList.add('primary');
    else button.classList.add('ghost');
    button.addEventListener('click', onClick);
    panel.append(button);
  }

  // -------------------------------------------------------------------- main

  private buildMain(panel: HTMLElement): void {
    this.heading(panel, 'Nitrobowl', 'Helios Dome');

    this.section(panel, 'Match');
    this.choiceRow(
      panel,
      'Team size',
      [
        { value: 1 as const, label: '1v1' },
        { value: 2 as const, label: '2v2' },
        { value: 3 as const, label: '3v3' },
      ],
      this.config.teamSize,
      (v) => (this.config.teamSize = v),
    );
    this.choiceRow(
      panel,
      'Opponents',
      (['rookie', 'pro', 'ace'] as const).map((value) => ({
        value,
        label: DIFFICULTY_LABELS[value],
        title:
          value === 'rookie'
            ? 'Slow to react, rarely flips, stays on the ground.'
            : value === 'pro'
              ? 'Reads the ball ahead, uses boost and takes to the air.'
              : 'Fast reactions, accurate, uses flips and aerials freely.',
      })),
      this.config.difficulty,
      (v) => (this.config.difficulty = v),
    );
    this.choiceRow(
      panel,
      'Length',
      MATCH_DURATIONS.map((value) => ({ value, label: `${value / 60}:00` })),
      this.config.duration,
      (v) => (this.config.duration = v),
    );

    this.section(panel, 'Car');
    this.choiceRow(
      panel,
      'Body',
      BODY_TYPES.map((body) => ({ value: body.id, label: body.name, title: body.blurb })),
      this.config.bodyId,
      (v) => (this.config.bodyId = v),
    );

    const paintRow = document.createElement('div');
    paintRow.className = 'row';
    const paintLabel = document.createElement('label');
    paintLabel.textContent = 'Paint';
    const swatches = document.createElement('div');
    swatches.className = 'choices';
    for (const color of PAINT_SWATCHES) {
      const swatch = document.createElement('button');
      swatch.className = 'swatch';
      swatch.style.background = `#${color.toString(16).padStart(6, '0')}`;
      swatch.title = 'Paint colour';
      if (color === this.config.paint) swatch.classList.add('selected');
      swatch.addEventListener('click', () => {
        this.config.paint = color;
        this.callbacks.onConfigChanged();
        this.render();
      });
      swatches.append(swatch);
    }
    paintRow.append(paintLabel, swatches);
    panel.append(paintRow);

    this.button(panel, 'Kick off', () => this.callbacks.onStart(), true);

    const buttons = document.createElement('div');
    buttons.className = 'choices';
    buttons.style.marginTop = '12px';
    panel.append(buttons);
    this.button(buttons, 'Settings', () => this.show('settings'));
    this.button(buttons, 'Controls', () => this.show('controls'));

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML = `
      <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive &middot;
      <kbd>Space</kbd> jump, tap again with a direction to flip &middot;
      <kbd>Shift</kbd> boost &middot;
      <kbd>Ctrl</kbd> powerslide &middot;
      <kbd>Alt</kbd> hold for air roll &middot;
      <kbd>C</kbd> ball cam &middot;
      <kbd>F3</kbd> debug overlay.
      <br>Airborne, <kbd>W</kbd>/<kbd>S</kbd> pitch and <kbd>A</kbd>/<kbd>D</kbd> yaw.
      A controller works too.`;
    panel.append(hint);
  }

  // ---------------------------------------------------------------- settings

  private buildSettings(panel: HTMLElement): void {
    this.heading(panel, 'Settings');

    this.section(panel, 'Camera');
    this.sliderRow(panel, 'Field of view', 60, 120, 1, this.camera.fov, (v) => `${v}°`, (v) => {
      this.camera.fov = v;
    });
    this.sliderRow(panel, 'Distance', 100, 420, 5, this.camera.distance, (v) => `${v}`, (v) => {
      this.camera.distance = v;
    });
    this.sliderRow(panel, 'Height', 30, 220, 5, this.camera.height, (v) => `${v}`, (v) => {
      this.camera.height = v;
    });
    this.sliderRow(panel, 'Angle', -18, 2, 0.5, this.camera.angle, (v) => `${v.toFixed(1)}°`, (v) => {
      this.camera.angle = v;
    });
    this.sliderRow(panel, 'Stiffness', 0, 1, 0.05, this.camera.stiffness, (v) => v.toFixed(2), (v) => {
      this.camera.stiffness = v;
    });
    this.sliderRow(panel, 'Swivel speed', 1, 10, 0.5, this.camera.swivelSpeed, (v) => v.toFixed(1), (v) => {
      this.camera.swivelSpeed = v;
    });
    this.choiceRow(
      panel,
      'Default view',
      [
        { value: true, label: 'Ball cam' },
        { value: false, label: 'Car cam' },
      ],
      this.camera.ballCam,
      (v) => (this.camera.ballCam = v),
    );

    this.section(panel, 'Audio');
    this.choiceRow(
      panel,
      'Sound',
      [
        { value: true, label: 'On' },
        { value: false, label: 'Off' },
      ],
      this.state.audioEnabled,
      (v) => {
        this.state.audioEnabled = v;
        this.audio.setEnabled(v);
      },
    );
    this.sliderRow(panel, 'Volume', 0, 1, 0.05, this.state.volume, (v) => `${Math.round(v * 100)}%`, (v) => {
      this.state.volume = v;
      this.audio.setVolume(v);
    });

    this.button(panel, 'Back', () => this.show(this.previousScreen()), true);
  }

  // ---------------------------------------------------------------- controls

  private buildControls(panel: HTMLElement): void {
    this.heading(panel, 'Controls');

    const note = document.createElement('div');
    note.className = 'hint';
    note.style.marginBottom = '10px';
    note.textContent =
      'Click a key to rebind it, then press the key or mouse button you want. Gamepads use the standard layout and need no setup.';
    panel.append(note);

    const status = document.createElement('div');
    status.className = 'pill';
    status.classList.toggle('live', this.input.gamepadConnected);
    status.textContent = this.input.gamepadConnected ? 'Gamepad connected' : 'No gamepad';
    panel.append(status);

    this.section(panel, 'Bindings');
    for (const action of Object.keys(ACTION_LABELS) as Action[]) {
      const row = document.createElement('div');
      row.className = 'binding-row';

      const label = document.createElement('span');
      label.textContent = ACTION_LABELS[action];
      row.append(label);

      for (let slot = 0; slot < 2; slot++) {
        const button = document.createElement('button');
        button.className = 'key';
        const code = this.input.bindings[action][slot];
        button.textContent = code ? describeCode(code) : '—';
        button.addEventListener('click', () => {
          button.classList.add('listening');
          button.textContent = 'Press a key…';
          this.input.capture = (pressed) => {
            this.input.rebind(action, slot, pressed);
            this.render();
          };
        });
        row.append(button);
      }
      panel.append(row);
    }

    const buttons = document.createElement('div');
    buttons.className = 'choices';
    buttons.style.marginTop = '18px';
    panel.append(buttons);
    this.button(buttons, 'Reset to defaults', () => {
      this.input.resetBindings();
      this.render();
    });

    this.button(panel, 'Back', () => this.show(this.previousScreen()), true);
  }

  /** Settings and controls are reachable from both the menu and the pause screen. */
  private cameFromPause = false;

  private previousScreen(): Screen {
    return this.cameFromPause ? 'pause' : 'main';
  }

  // ------------------------------------------------------------------- pause

  private buildPause(panel: HTMLElement): void {
    this.cameFromPause = true;
    this.heading(panel, 'Paused');
    this.button(panel, 'Resume', () => this.callbacks.onResume(), true);

    const buttons = document.createElement('div');
    buttons.className = 'choices';
    buttons.style.marginTop = '12px';
    panel.append(buttons);
    this.button(buttons, 'Settings', () => this.show('settings'));
    this.button(buttons, 'Controls', () => this.show('controls'));
    this.button(buttons, 'Restart match', () => this.callbacks.onRestart());
    this.button(buttons, 'Main menu', () => {
      this.cameFromPause = false;
      this.callbacks.onQuitToMenu();
    });
  }

  // ------------------------------------------------------------------ result

  private buildResult(panel: HTMLElement): void {
    this.cameFromPause = false;
    const result = this.result;
    this.heading(panel, result?.headline ?? 'Full time', result?.sub ?? '');

    if (result?.team !== null && result?.team !== undefined) {
      const pill = document.createElement('div');
      pill.className = 'pill live';
      pill.textContent = `${TEAM_NAMES[result.team]} win`;
      panel.append(pill);
    }

    this.button(panel, 'Play again', () => this.callbacks.onRestart(), true);
    const buttons = document.createElement('div');
    buttons.className = 'choices';
    buttons.style.marginTop = '12px';
    panel.append(buttons);
    this.button(buttons, 'Main menu', () => this.callbacks.onQuitToMenu());
  }
}
