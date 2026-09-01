import './ui/styles.css';
import { Game } from './game/game';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

try {
  const game = new Game(canvas, ui);
  game.start();
} catch (error) {
  console.error(error);
  ui.innerHTML = `
    <div class="overlay clickable">
      <div class="panel">
        <h1>Nitrobowl</h1>
        <p class="tagline">Could not start</p>
        <div class="hint">This game needs WebGL 2. If your browser supports it, try
        reloading or enabling hardware acceleration.<br><br>
        <code>${error instanceof Error ? error.message : String(error)}</code></div>
      </div>
    </div>`;
}
