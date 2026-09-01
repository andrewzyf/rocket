/**
 * In-match HUD: score, clock, boost meter, speed, and the centre banner used
 * for the countdown, goal calls and the final whistle.
 *
 * Plain DOM rather than canvas: it stays crisp at any resolution, costs nothing
 * per frame as long as we only touch nodes whose text actually changed, and the
 * layout work is CSS rather than hand-rolled measurement.
 */

import { CAR_MAX_SPEED, TEAM_NAMES } from '../core/constants';
import { clamp } from '../core/math';

const RADIUS = 62;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export class Hud {
  readonly root = document.createElement('div');

  private readonly scoreValues: HTMLElement[] = [];
  private readonly clockValue: HTMLElement;
  private readonly clockLabel: HTMLElement;
  private readonly clockBox: HTMLElement;
  private readonly boostBox: HTMLElement;
  private readonly boostFill: SVGCircleElement;
  private readonly boostAmount: HTMLElement;
  private readonly speedBox: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerHeadline: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly countdown: HTMLElement;

  private lastScore: [number, number] = [-1, -1];
  private lastClock = '';
  private lastBoost = -1;
  private lastSpeed = -1;

  constructor() {
    this.root.innerHTML = `
      <div class="scoreboard">
        <div class="team blue"><div class="name">${TEAM_NAMES[0]}</div><div class="value">0</div></div>
        <div class="clock"><div class="value">5:00</div><div class="label"></div></div>
        <div class="team orange"><div class="name">${TEAM_NAMES[1]}</div><div class="value">0</div></div>
      </div>
      <div class="boost">
        <svg viewBox="0 0 148 148" aria-hidden="true">
          <circle class="track" cx="74" cy="74" r="${RADIUS}"></circle>
          <circle class="fill" cx="74" cy="74" r="${RADIUS}"
            stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${CIRCUMFERENCE}"></circle>
        </svg>
        <div class="amount">0</div>
      </div>
      <div class="speed">0 KM/H</div>
      <div class="banner"><div class="headline"></div><div class="sub"></div></div>
      <div class="countdown" style="display:none"></div>
    `;

    const teams = this.root.querySelectorAll('.scoreboard .team .value');
    this.scoreValues.push(teams[0] as HTMLElement, teams[1] as HTMLElement);
    this.clockBox = this.root.querySelector('.clock') as HTMLElement;
    this.clockValue = this.clockBox.querySelector('.value') as HTMLElement;
    this.clockLabel = this.clockBox.querySelector('.label') as HTMLElement;
    this.boostBox = this.root.querySelector('.boost') as HTMLElement;
    this.boostFill = this.root.querySelector('.boost .fill') as unknown as SVGCircleElement;
    this.boostAmount = this.root.querySelector('.boost .amount') as HTMLElement;
    this.speedBox = this.root.querySelector('.speed') as HTMLElement;
    this.banner = this.root.querySelector('.banner') as HTMLElement;
    this.bannerHeadline = this.banner.querySelector('.headline') as HTMLElement;
    this.bannerSub = this.banner.querySelector('.sub') as HTMLElement;
    this.countdown = this.root.querySelector('.countdown') as HTMLElement;
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  setScore(blue: number, orange: number): void {
    if (this.lastScore[0] !== blue) {
      this.scoreValues[0].textContent = String(blue);
      this.lastScore[0] = blue;
    }
    if (this.lastScore[1] !== orange) {
      this.scoreValues[1].textContent = String(orange);
      this.lastScore[1] = orange;
    }
  }

  setClock(text: string, overtime: boolean, stoppage: boolean): void {
    if (this.lastClock !== text) {
      this.clockValue.textContent = text;
      this.lastClock = text;
    }
    this.clockBox.classList.toggle('overtime', overtime);
    const label = overtime ? 'Overtime' : stoppage ? 'Ball in play' : '';
    if (this.clockLabel.textContent !== label) this.clockLabel.textContent = label;
  }

  setBoost(amount: number): void {
    const rounded = Math.round(amount);
    if (rounded === this.lastBoost) return;
    this.lastBoost = rounded;

    const fraction = clamp(amount / 100, 0, 1);
    this.boostFill.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - fraction));
    this.boostAmount.textContent = String(rounded);
    this.boostBox.classList.toggle('full', rounded >= 100);
    this.boostBox.classList.toggle('empty', rounded <= 0);
  }

  /** `speed` in uu/s; displayed in km/h, since 1 uu = 1 cm. */
  setSpeed(speed: number, supersonic: boolean): void {
    const kmh = Math.round((speed * 0.036) / 1) ;
    if (kmh !== this.lastSpeed) {
      this.speedBox.textContent = `${kmh} KM/H`;
      this.lastSpeed = kmh;
    }
    this.speedBox.classList.toggle('supersonic', supersonic);
    void CAR_MAX_SPEED;
  }

  showBanner(headline: string, sub = '', team?: number): void {
    this.bannerHeadline.textContent = headline;
    this.bannerSub.textContent = sub;
    this.banner.classList.remove('blue', 'orange');
    if (team === 0) this.banner.classList.add('blue');
    if (team === 1) this.banner.classList.add('orange');
    this.banner.classList.add('show');
  }

  hideBanner(): void {
    this.banner.classList.remove('show');
  }

  showCountdown(text: string | null): void {
    if (text === null) {
      this.countdown.style.display = 'none';
      return;
    }
    this.countdown.style.display = '';
    if (this.countdown.textContent !== text) this.countdown.textContent = text;
  }
}
