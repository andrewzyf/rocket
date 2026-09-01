# NITROBOWL — Design & Physics Research

> **Working title:** *Nitrobowl*
> **Arena:** *Helios Dome*
> **Car bodies:** *Wedge*, *Slab*, *Kite* (all original silhouettes)

An original, browser-playable rocket-powered car-soccer game. This document is the
**Phase 0 research deliverable**: it records the concrete numbers and mechanical rules
that the implementation targets, so later phases tune against data instead of vibes.

## 0. Legal / originality framing

This project recreates a **genre and its physics feel**, which are not copyrightable.
It contains **none** of the following:

- No Psyonix / Rocket League names, logos, or branding.
- No licensed or in-game car names (the bodies here are *Wedge*, *Slab*, *Kite*).
- No extracted, ripped, or derived art, audio, meshes, or textures. Every mesh is
  built procedurally from Three.js primitives; every sound is synthesised at runtime
  with the Web Audio API.
- Arena, palette, HUD and naming are original.

What *is* reproduced deliberately is the **simulation model** — the equations of motion,
acceleration curves, impulse magnitudes and arena proportions — sourced from the public
bot-development / reverse-engineering community (RLBot wiki, RLGym, RLUtilities). These
are published measurements of how a physics engine behaves, and are used here as a
tuning target for an independently written engine.

---

## 1. Units

The reference game is built in Unreal Engine and its community measurements are all in
**Unreal Units (uu)**. The community consensus (RLGym `common_values.py`,
`UNREAL_UNITS_PER_METER = 100`) is:

> **1 uu = 1 cm.** 1 m = 100 uu. 2778 uu/s = 100 km/h.

> ⚠️ The brief suggested `1 uu ≈ 1.9 cm`. Every primary source disagrees: the ball radius
> is 91.25 uu and the real reference ball is ~1.8 m across, which only works at 1 uu = 1 cm.
> **We use 1 uu = 1 cm.** All community numbers below therefore map in directly.

**Rendering:** the Three.js scene is authored *directly in uu* (scene unit = 1 uu = 1 cm).
This avoids a conversion layer entirely; the camera just uses `near = 10`, `far = 40000`.

**Coordinate frame** (matches the reference game, so community numbers drop in unchanged):

| Axis | Meaning |
| --- | --- |
| `+X` | to the right when standing in the blue goal looking out |
| `+Y` | toward the **orange** goal |
| `+Z` | up |

Three.js is Y-up by default; we keep the **physics** in Z-up (so all the sourced constants
are literal) and apply a single fixed Z-up→Y-up basis swap when writing transforms to
render objects. See `src/render/frame.ts`.

---

## 2. Global constants

| Quantity | Value | Source |
| --- | --- | --- |
| Physics tick rate | **120 Hz** (`dt = 1/120`) | RLBot jumping-physics page |
| Gravity | **650 uu/s²** down | RLBot / RLGym |
| Car mass | **180** (arbitrary units) | RLGym `CAR_MASS` |
| Ball mass | **30** | RLGym `BALL_MASS` |
| Car max speed | **2300 uu/s** (hard cap, boost cannot exceed) | RLGym `CAR_MAX_SPEED` |
| Supersonic threshold | **2200 uu/s** | RLGym `SUPERSONIC_THRESHOLD` |
| Supersonic hysteresis | stays supersonic for **1 s** while above 2100 uu/s | Demolition wiki |
| Max drive speed (no boost) | **1410 uu/s** (throttle-only asymptote ≈1400–1410) | RLBot wiki |
| Car max angular velocity | **5.5 rad/s** | RLGym `CAR_MAX_ANG_VEL` |
| Ball max speed | **6000 uu/s** | RLGym `BALL_MAX_SPEED` |
| Ball max angular velocity | **6.0 rad/s** | RLBot wiki |

The tick rate matters: jump-hold windows and dodge timers are specified in ticks, and
mechanics like the 3-tick minimum jump only reproduce correctly at a fixed 120 Hz step.
The renderer runs on `requestAnimationFrame` with an **accumulator** feeding fixed 120 Hz
physics ticks, and interpolates transforms for display.

---

## 3. Car hitbox

Cars collide with the world and the ball through a **box hitbox**, *not* the visual mesh.
This is the single most important fidelity detail in the whole game: it is why "wheel
touches" and "nose clips" behave strangely — the visible wheel is outside the box, and the
box's flat top surface is what the ball actually rides on.

Reference hitbox (the "Wedge" body, from `RLUtilities/src/simulation/car.cc`):

```
half extents  = (59.00368881, 42.09970474, 18.07953644)   // x = forward, y = left, z = up
centre offset = (13.97565993, 0.0, 20.75498772)            // relative to car origin
```

So the full box is **118.0 × 84.2 × 36.2 uu**, pushed forward 13.98 uu and up 20.75 uu from
the body origin. (Community-published "Octane 127.02 × 82.19 × 34.16" figures are a slightly
different measurement convention; we use the RLUtilities numbers because they come with a
matching inertia tensor.)

**Inertia tensor** (`I = m * diag(751, 1334, 1836)`, from the same source) — needed for the
car-ball impulse to distribute correctly.

Three original bodies are offered, using the same shape family:

| Body | Half extents | Notes |
| --- | --- | --- |
| **Wedge** | `(59.00, 42.10, 18.08)` | balanced, the default |
| **Slab** | `(63.00, 41.65, 15.65)` | longer + flatter (flat-nose family) |
| **Kite** | `(59.29, 45.55, 14.90) ` | widest + flattest (plank family) |

Only the box and the visual mesh change — the controller is identical.

---

## 4. Ground driving

All of the following is a direct port of the reverse-engineered model in
`RLUtilities/src/simulation/car.cc` (`drive_force_forward`, `drive_force_left`,
`drive_torque_up`).

### 4.1 Forward force

Let `v_f` = forward speed, `v_l` = leftward speed, `w_u` = yaw rate about the car's up axis.

```
driving_speed        = 1450        // throttle-only asymptote
throttle_force       = 1550
braking_force        = -3500       // uu/s^2, applied when throttle opposes motion
coasting_force       = -525        // uu/s^2, applied when throttle ~ 0
max_speed            = 2275        // internal boost target
boost_accel          = 991.667     // uu/s^2 on the ground
throttle_threshold   = 0.05
braking_threshold    = -0.001
min_speed            = 10
supersonic_turn_drag = -98.25

turn_damping = ( -0.07186693033945346 * |steer|
                 -0.05545323728191764 * |w_u|
                 +0.00062552963716722 * |v_l| ) * v_f
```

**Boosting:**
- `v_f < 0` → `+3500` (boost brakes a reversing car hard)
- `v_f < 1450` → **`max_speed - v_f`** — note this is a *velocity-dependent* force, which is
  what makes low-speed boost feel so punchy (≈2275 uu/s² from a standstill) and then taper.
- `1450 ≤ v_f < 2275` → `boost_accel + turn_damping` (≈991.67)
- `v_f ≥ 2275` → `supersonic_turn_drag * |w_u|` (turning while supersonic bleeds speed)

**Not boosting:**
- throttle opposes velocity and `|v_f| > 10` → `braking_force * sign(v_f)` (**-3500**)
- `|throttle| < 0.05` and `|v_f| > 10` → `coasting_force * sign(v_f) + turn_damping` (**-525**)
- `|v_f| > 1450` → `turn_damping` only (no more forward drive above the throttle cap)
- otherwise → **`throttle * (1550 - |v_f|) + turn_damping`**

That last line is *the* acceleration curve: linear falloff from **1550 uu/s²** at rest to
**0 at 1550 uu/s**, damped by turning. Combined with the `1450` gate the car settles at
~1410 uu/s, matching the published "max driving speed with no boost".

### 4.2 Lateral force and yaw

```
F_left = (1380.4531378*steer + 7.8281188*throttle - 15.0064029*v_l + 668.1208332*w_u)
         * (1 - exp(-0.001161 * |v_f|))

torque_up = 15.0 * (steer * max_curvature(|v_f|) * v_f - w_u)
```

The `(1 - exp(-0.001161*|v_f|))` term is why a stationary car cannot turn: lateral grip
scales in with speed. The yaw torque is a **servo onto a target yaw rate** derived from a
curvature table — this is why the car's turn rate is so predictable.

### 4.3 Turn radius vs speed (`max_curvature`)

Piecewise-linear curvature (1/uu) as a function of speed:

| Speed range (uu/s) | curvature(v) | radius at range start |
| --- | --- | --- |
| 0–500 | `0.0069 − 5.84e-6·v` | 145 uu |
| 500–1000 | `0.00561 − 3.26e-6·v` | 251 uu |
| 1000–1500 | `0.0043 − 1.95e-6·v` | 435 uu |
| 1500–1750 | `0.003025 − 1.1e-6·v` | 755 uu |
| 1750–2300 | `0.0018 − 4.0e-7·v` | 909 uu |
| ≥2300 | `0.00088` | 1136 uu |

Turning radius therefore grows from **~1.5 m at walking pace to ~11 m at supersonic** — the
"tightens at low speed" feel. A full-throttle full-steer circle settles at ≈**1234 uu/s**
and takes ≈**3.1 s** for 360° (90° in ~0.775 s).

### 4.4 Powerslide (handbrake)

The handbrake is **not** a drift-boost. It:
- **kills lateral grip** (we scale the `F_left` grip term to ~10%),
- **raises the achievable yaw rate** (curvature multiplier ~1.9×) so the car rotates
  tighter than the curvature table allows,
- **preserves forward speed** far better than braking does (a small coasting-like drag only).

The result is the intended use: snap the car's heading around without dumping speed, then
release and re-grip. Also used to slide along walls and to control landings.

### 4.5 Sticky force

While wheels are in surface contact, an extra **325 uu/s²** presses the car into the
surface along `-up`. This is what makes wall and ceiling driving possible. It is
**suppressed for 3 ticks (25 ms) after a jump** so the jump isn't immediately cancelled.

---

## 5. Jumping, flips and dodges

From `RLUtilities/src/mechanics/{jump,dodge}.cc` and the RLBot jumping-physics page.

| Constant | Value |
| --- | --- |
| `Jump.speed` (instant impulse) | **291.667 uu/s** along the car's roof normal |
| `Jump.acceleration` (hold force) | **1458.333 uu/s²** while jump is held |
| `Jump.min_duration` | **0.025 s** (3 ticks — always applied, ≈+36.5 uu/s) |
| `Jump.max_duration` | **0.2 s** (hold cap → up to ≈+291.7 uu/s extra) |
| Dodge window (`Dodge.timeout`) | **1.25 s** after the first jump (+0.2 s if held to max) |
| Dodge stick threshold | `|pitch| + |roll| + |yaw| ≥ 0.5` |
| Dodge torque time | **0.65 s** |
| Dodge forward torque | **224** |
| Dodge side torque | **260** |
| Dodge planar impulse | **500 uu/s** in the dodge direction |
| Backward-dodge impulse scaling | see below |
| Dodge Z damping | **0.35**, active from **t=0.15 s**, forced until **t=0.21 s** |

### 5.1 Jump

Pressing jump on the ground applies an **immediate 291.667 uu/s** impulse along the car's
**up** vector (not world up — this is why you jump *off* a wall sideways). Holding the
button adds `1458.333 uu/s²` for up to 0.2 s. During the first 3 ticks the hold force is
`0.75 * 1458.333` up **and −510 uu/s² forward**, a small backward kick.

Peak single jump ≈ 292 + 292 = **~583 uu/s** upward → about **2.6 m** of air.

### 5.2 Second jump / dodge

Once airborne with a jump used, the second press is available **once per landing**:

- **No directional input** (`|pitch|+|roll|+|yaw| < 0.5`) → **double jump**: another flat
  **291.667 uu/s** along the roof normal, no rotation. Grants more height, no flip.
- **Directional input** → **dodge/flip**:
  - `dodge_dir = normalize(-pitch, yaw)` in the car's ground plane.
  - Components below 0.1 are snapped to 0 (so near-cardinal inputs give clean flips).
  - Planar velocity impulse `Δv = 500 * dodge_dir` applied in the car's yaw frame.
  - **Backward dodge special case:** if the dodge is opposite the current motion, the
    impulse is scaled — the classic "backflip cancels forward speed then reverses".
  - Angular impulse `dodge_torque = cross(dodge_dir * (224 fwd, 260 side))`, applied every
    tick for **0.65 s** — this is the rotation, and it is *torque over time*, not an instant
    spin. Crucially, **pitch input is locked out for the first 0.3 s** of a dodge.
  - Vertical velocity is damped by 35% between t=0.15 s and t=0.21 s (and any time `vz<0`
    after 0.15 s) — this is why a front-flip "sticks" to the ground instead of floating.

### 5.3 Named techniques these enable (all emergent, none special-cased)

| Technique | What it actually is |
| --- | --- |
| **Wavedash** | Land while the dodge torque is still running: the flip's planar 500 uu/s impulse converts to ground speed at touchdown instead of being wasted in the air. Free speed with no boost. |
| **Half-flip** | Backflip + immediate **roll 180°** + pitch-cancel, so the car ends up facing the opposite direction while keeping the backflip's speed. Fastest turnaround. |
| **Speed-flip** | Diagonal dodge with a roll/yaw cancel that keeps the nose forward while banking the 500 uu/s impulse mostly along the travel direction. Kickoff staple. |
| **Flip reset** | Any **wheel contact** with the ball (or a surface) mid-air re-arms the flip. Falls straight out of "flip is available while `on_ground` was true at any recent point", so we re-arm the dodge whenever ≥1 wheel registers a contact. |
| **Air roll shot / ceiling shot** | Just free roll authority + wall/ceiling driving. |

None of these need bespoke code — they exist if the primitives above are exact.

---

## 6. Air control (aerials)

From `Car::aerial_control`. This is **torque-based, frame-rate-integrated**, and completely
independent of the wheels.

```
J = 10.5                                     // effective moment of inertia scalar
T = (-400, -130,  95)                        // (roll, pitch, yaw) drive torque coefficients
H = (-50, -30*(1-|pitch|), -20*(1-|yaw|))    // damping torque coefficients

w_local  = w in car frame
w       += o * (T*rpy + H*w_local) * (dt / J)
```

Key consequences to preserve:

- **Roll is ~3× stronger than pitch and ~4× stronger than yaw** (`|−400| vs |−130| vs 95`).
  This is *the* reason high-level play is built on air-roll: it's the fastest axis.
- Yaw torque is **positive** (opposite sign convention) — mind the handedness.
- Damping on pitch/yaw is **reduced while the stick is held** (`1-|pitch|`), so the car keeps
  rotating while you hold and snaps to a stop when you let go. This "release to stop" is a
  huge part of aerial feel and is easy to miss.
- Angular velocity is clamped to **5.5 rad/s**.

**Air throttle:** `66.667 uu/s²` forward (`33.334` reverse) — a tiny nudge, not real thrust.

**Air boost:** `boost_accel + throttle_accel = 1060 + 66.667 uu/s²` along the nose.
(The ground figure 991.666 and the air figure 1060 differ in the sources; we use
991.666 grounded, 1060 airborne, matching RLGym and RLUtilities respectively.)

---

## 7. Ball physics

From `RLUtilities/src/simulation/ball.cc`.

| Constant | Value |
| --- | --- |
| Radius (visual) | **91.25 uu** |
| Radius (collision) | **93.15 uu** — collision sphere is slightly larger than the render sphere |
| Resting height | **93.15 uu** |
| Mass | **30** |
| Restitution | **0.60** |
| Drag | **−0.0305** (per second, applied as `v += drag * v * dt`) |
| Friction `mu` | **2.0** |
| Max speed | **6000 uu/s** |
| Max angular velocity | **6.0 rad/s** |
| Inertia | `0.4 * m * r²` (solid sphere) |

**Restitution 0.60** is what makes the ball feel like a beach ball with weight rather than a
real football (≈0.8 on grass) — high enough for long bounces, low enough to be controllable.

### 7.1 Ball vs world

An impulse-based resolve with Coulomb friction, not a naive reflection:

```
L         = contact_point - ball_pos
m_reduced = 1 / (1/m + |L|²/I)
v_perp    = min(dot(v, n), 0) * n
v_para    = v - v_perp - cross(L, w)
ratio     = |v_perp| / max(|v_para|, 1e-4)
J_perp    = -(1 + restitution) * m * v_perp
J_para    = -min(1, mu * ratio) * m_reduced * v_para
J         = J_perp + J_para
w        += cross(L, J) / I
v        += J/m + drag*v*dt
```

The `min(1, mu*ratio)` clamp is why a ball rolled up a wall gains spin instead of just
sliding, and why bounce angles are spin-dependent.

### 7.2 Ball vs car — **the important one**

This is *two* impulses, and the second one is not physical at all:

**(a)** A rigid-body inelastic impulse `J1` between the ball sphere and the car's **OBB**,
using the closest point on the box, both bodies' inertia tensors, with the same Coulomb
friction clamp. This is the "correct" part.

**(b)** An extra **"Psyonix impulse"** `J2` added on top, purely so hits feel powerful:

```
n2 = ball_pos - car_pos
n2.z *= 0.35                                  // flatten the vertical component
n2 = normalize(n2 - 0.35 * dot(n2, forward) * forward)   // bias away from the nose axis
dv = min(|v_ball - v_car|, 4600)
J2 = m_ball * dv * scale(dv) * n2

scale(dv):  dv=0    -> 0.65
            dv=500  -> 0.65
            dv=2300 -> 0.55
            dv=4600 -> 0.30      (linear interpolation between these knots)
```

Consequences worth understanding before tuning:

- The extra kick is **radial from the car's centre**, not from the contact point. This is
  precisely why **hitting the ball with a wheel or a corner sends it in a direction the
  contact geometry doesn't justify** — the game adds a shove along centre-to-centre
  regardless of where you actually touched it. It is an emergent artifact of the model,
  not a designed behaviour, and reproducing it is required for the feel.
- The `n2.z *= 0.35` flattening makes hits go **forward** more than up, which is why you
  must get *under* the ball to lift it.
- The `- 0.35 * dot(n2, f) * f` term reduces the kick when the ball is directly ahead,
  making straight-on nose hits weaker than 45° hits.
- Because `scale` decays with closing speed, very fast touches transfer proportionally
  *less* bonus — dribbles and slow touches feel "sticky", flip-resets feel controllable.

**Dribbling** works because the car's hitbox has a **flat top** at z≈38.8 uu and the ball's
collision sphere rests in a shallow virtual well created by the J1/J2 balance.

---

## 8. Boost economy

| Quantity | Value |
| --- | --- |
| Tank capacity | **100** |
| Starting boost (kickoff) | **33** |
| Consumption while boosting | **33.3 / second** (≈3 s from full) |
| Small pad | **+12**, respawn **4 s** |
| Big pad | **+100** (fills tank), respawn **10 s** |
| Small pads on field | **28** |
| Big pads on field | **6** |
| Pad pickup radius | small ≈144 uu, big ≈208 uu; height ≈165 uu |

**Big pad layout** — 6 pads, at `z = 73`:

```
(±3072, ±4096)     4 corner pads
(±3584,     0)     2 midfield side pads
```

**Small pads** — 28 pads at `z = 70`, symmetric about both axes:

```
(     0, ±4240)  (±1792, ±4184)  (±940, ±3308)  (0, ±2816)
(±3584, ±2484)   (±1788, ±2300)  (±2048, ±1036) (0, ±1024)  (±1024, 0)
```

(Full 34-entry table lives in `src/core/constants.ts` as `BOOST_PADS`.)

The design intent: big pads are on the outside so committing to one costs you position, and
the 10 s respawn means contesting them is a real resource decision. Small pads form lanes
down the middle so a rotating player can refill *on the way back* without detouring.

---

## 9. Arena geometry

| Feature | Value |
| --- | --- |
| Floor | `z = 0` |
| Ceiling | `z = 2044` |
| Side walls | `x = ±4096` |
| Back walls | `y = ±5120` |
| Back of net | `y = ±6000` |
| Goal height | **642.775** |
| Goal centre-to-post | **892.755** (so the mouth is 1785.5 wide) |
| Goal depth | **880** |
| Goal-scored threshold | ball centre past `|y| = 5215.5` |
| Corner cut length | **1152** per cathetus |
| Corner plane | `|x| + |y| ≤ 8064` |
| Floor→wall / wall→ceiling fillet radius | **256** (`RAMP_HEIGHT`) |

The playfield is **8192 × 10240 uu (81.9 m × 102.4 m)**, i.e. a long rectangle with a
**1.25:1** length:width ratio. The goal mouth is **1785.5 uu = 21.8 %** of the field width.

**No sharp interior corners anywhere.** Every plane-plane junction is a **cylindrical
fillet** of radius 256, and every three-plane junction is a **spherical fillet** of the same
radius. This is what allows a car to drive continuously from floor onto wall onto ceiling,
and what makes the ball roll around the corners instead of wedging.

**Implementation:** the arena interior (ignoring the goal recesses) is a **convex** region —
an intersection of 10 half-spaces (floor, ceiling, 2 side walls, 2 back walls, 4 corner
walls) with rounded edges. We therefore represent it as a **signed distance field**:

```
d(p) = min over planes i of (d_i - n_i·p)          // n_i outward, interior is n_i·p <= d_i
     , with each edge pair (i,j) whose offset planes are both violated replaced by
       R - dist(p, axis_ij)                        // axis = intersection of the two inset planes
     , and each triple (i,j,k) similarly replaced by R - dist(p, corner_ijk)
```

Goals are handled as explicit exceptions: the back-wall half-space is disabled inside the
goal mouth rectangle, and a separate goal box (back at `|y| = 6000`, sides at
`|x| = 892.755`, roof at `z = 642.775`) takes over.

This gives exact contact points and normals for the ball, exact suspension raycasts for the
wheels (via sphere-tracing the SDF), and costs nothing to evaluate. It is also *why* we
don't need a general-purpose physics engine — see §12.

### 9.1 Kickoff spawns

Five positions per side (mirrored for orange, negated in both x and y):

| Name | Blue position | Facing |
| --- | --- | --- |
| Right corner | `(-2048, -2560)` | toward ball |
| Left corner | `( 2048, -2560)` | toward ball |
| Back right | `( -256, -3840)` | +Y |
| Back left | `(  256, -3840)` | +Y |
| Far back centre | `(    0, -4608)` | +Y |

Spawn `z = 17` (wheels on the ground). In 1v1 both cars take the far-back-centre spawn;
in 2v2 the two corners; in 3v3 corners + one back position.

Post-goal (non-kickoff) respawn uses `y = ±4608` positions spread across the goal mouth.

---

## 10. Camera

Default third-person spring-arm camera (values are the reference game's modern defaults,
which we ship as our defaults and expose in the settings menu):

| Setting | Default | Range |
| --- | --- | --- |
| FOV | **110°** | 60–110 |
| Distance | **270 uu** | 100–400 |
| Height | **110 uu** | 40–200 |
| Angle | **−4.0°** (pitched down) | −15…0 |
| Stiffness | **0.5** | 0–1 |
| Swivel speed | **5.0** | 1–10 |
| Transition speed | **1.20** | 0.2–2 |

Behaviour:

- **Ball cam (default, toggled):** the camera's *look target* is the ball; the arm is placed
  behind the car **along the car→ball direction** projected to the horizontal, so the car and
  ball are both framed. This is why ball cam automatically shows you the play.
- **Car cam:** the arm sits directly behind the car's **velocity** direction (not its
  heading — this matters: the camera trails where you're going, so a powerslide shows you
  the drift). Falls back to heading below ~100 uu/s.
- **Stiffness** blends between "arm rigidly bolted to the car" (1.0) and "arm lags smoothly"
  (0.0). Implemented as a critically-damped spring whose rate is `lerp(6, 40, stiffness)`.
- The arm **does not roll** with the car — the camera up-vector stays world-up (this is
  essential; a rolling camera is unplayable).
- **Supersonic FOV kick:** FOV lerps by **+5°** over ~0.25 s when supersonic, back over
  ~0.4 s. Modest by design — the brief's "a few degrees" is right; more than ~6° is nauseating.
- Camera is placed by **sphere-casting** from the car so it doesn't clip through walls.

---

## 11. Match rules

| Rule | Value |
| --- | --- |
| Match length | **5:00** (also 3:00 / 8:00 options) |
| Kickoff countdown | **3 s** (`3 · 2 · 1 · GO`), cars frozen |
| Goal celebration | **~3 s** before reset (replay optional) |
| Overtime | **sudden death**, unlimited, clock counts up |
| Clock | stops during countdown and goal replays; a shot in flight at 0:00 keeps the clock alive until the ball touches ground/wall/car ("overtime-if-tied on ball dead") |
| Boost at kickoff | **33** |
| Pads | all pads respawn at kickoff |

### Demolition

- Requires the attacker to be **supersonic** (>2200 uu/s, or within the 1 s hysteresis).
- Geometric gate (from the community teardown):
  - the attacker-centre→impact-point line must be within **40°** of the attacker's forward,
  - the impact-point→victim-centre line must be within **55–90°** of the attacker's forward.
  In practice this means **you must hit them with your front**, not be clipped from behind.
- Both supersonic + fender-to-fender → **mutual demolition**.
- Below supersonic the same contact is a **bump**: a momentum-transfer impulse, no kill.
- **Respawn: 3 s** at a free spawn point near the victim's own goal, with boost topped to 33.

---

## 12. Technical approach — and one deviation from the brief

**Stack:** TypeScript + Three.js (r180) + Vite. No runtime dependencies beyond Three.js.

**Deviation, stated up front:** the brief recommended **Rapier3D** for physics. After the
research above I am **not** using it, and the whole game runs on a purpose-built 120 Hz
integrator in `src/physics/`. Reasoning:

1. Essentially **none** of the model above is a general rigid-body simulation. The car is
   driven by hand-authored force/torque curves; the ball-car interaction includes a
   non-physical bonus impulse (§7.2) that a solver would have to be disabled to allow; the
   dodge is a scripted torque over 0.65 s; air control is a torque servo. Using Rapier
   would mean switching off its solver for both bodies and then feeding it kinematic
   results — i.e. paying ~1 MB of WASM for nothing.
2. The arena is **analytic and convex** (§9), so contacts and raycasts are closed-form and
   exact. A triangle-mesh collider would be slower *and* less accurate at the fillets.
3. **Determinism.** A fixed 120 Hz hand-written step is bit-reproducible, which makes
   physics unit tests possible (there are 40 of them) and would make rollback netcode
   feasible later. Rapier's solver is deterministic per-build but far harder to reason about.

The brief's actual constraint — *"do not rely on an out-of-the-box vehicle physics
component; hand-roll the car controller"* — is satisfied maximally by this choice. If a
Rapier backend is wanted later, `src/physics/` is behind a narrow interface (`World.step`)
and could be swapped.

**Module layout:**

```
src/
  core/        constants, math (vec3/mat3/quat), fixed-step clock, input mapping
  physics/     field SDF, car controller, ball, world stepper, collision
  entities/    car + ball + boost-pad game objects (physics state ↔ render state)
  scenes/      arena construction, lighting, skybox, particles
  ai/          bot state machine + difficulty tiers
  ui/          HUD, menus, settings, debug overlay
  audio/       synthesised engine / boost / impact / crowd
  game/        match state machine, camera, replay
```

---

## 13. Visual & audio identity (original)

Deliberately **not** a copy — a distinct look in the same energetic arcade-sports register:

- **Palette:** deep indigo arena shell, hot **cyan** (team 1) vs hot **magenta** (team 2),
  amber boost pads, white field lines. Not blue/orange.
- **Arena:** *Helios Dome* — a low-poly ribbed dome with emissive rings that pulse to the
  match clock, and a solar-flare skybox gradient. Crowd is an instanced particle band, not
  billboards of people.
- **Cars:** three original silhouettes built from beveled boxes — *Wedge* (short arrow),
  *Slab* (long flat), *Kite* (wide flat). Flat-shaded, single accent stripe, no decals.
- **Boost trail:** a tapered ribbon of team-coloured quads with additive blending, plus
  point sparks; intensity tracks boost consumption.
- **Goal moment:** the ball detonates into a 300-particle burst in the scoring team's colour,
  the goal frame's emissive ring flashes, camera cuts to a slow-motion orbit.
- **Audio (all synthesised at runtime, zero sample files):** engine = two detuned sawtooth
  oscillators whose frequency tracks `|v|` with a boost-triggered octave layer; boost = filtered
  white noise with a resonant sweep; impacts = a short pitched noise burst scaled by impulse;
  crowd = band-passed pink noise whose gain follows "excitement" (ball near a goal).

---

## 14. Numbers we expect to re-tune during playtest

The research gets us close, not exact. Explicitly flagged as tuning targets:

1. `drive_force_left` grip coefficients — the source constants are a regression fit and may
   need damping at high speed to stop oscillation at 120 Hz.
2. Handbrake grip/curvature multipliers — **not** published anywhere; chosen by feel.
3. Suspension rest length and spring rate — the reference has no published values; we use
   rest 12 uu / stiffness 100 / damping 8 and verify against "car sits with hitbox bottom
   at z≈20.75−18.08 = 2.7 uu".
4. Fillet radius 256 at the wall→ceiling junction — plausible from `RAMP_HEIGHT` but not
   confirmed for the ceiling.
5. Demolition angle gates — sourced from a community teardown, not from code.
6. Bot reaction/aim constants — pure design.

---

## Sources

- [Useful Game Values — RLBot wiki](https://github.com/RLBot/RLBot/wiki/Useful-Game-Values)
- [Jumping Physics — RLBot wiki](https://github.com/RLBot/RLBot/wiki/Jumping-Physics)
- [RLGym `common_values.py`](https://github.com/RLGym/rocket-league-gym/blob/main/rlgym/rocket_league/common_values.py)
- [RLUtilities — `car.cc`, `ball.cc`, `jump.cc`, `dodge.cc`, `aerial.cc`](https://github.com/samuelpmish/RLUtilities)
- [Unraveling Rocket League](https://github.com/skyborgff/Unraveling-Rocket-League)
- [Demolition — community wiki](https://rocketleague.fandom.com/wiki/Demolition)
- [How demos actually work — GamersRdy](https://gamersrdy.com/blog/2020/06/11/how-demos-actually-work-in-rocket-league/)
- [Camera settings reference — Epic support](https://www.epicgames.com/help/c-202300000001622/c-202300000001682/what-are-camera-settings-in-rocket-league-a202300000018048)
- [Hitbox overview — Dignitas](https://dignitas.gg/articles/an-overview-of-hitboxes-in-rocket-league)
