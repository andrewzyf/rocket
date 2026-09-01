/**
 * Every tuned number in the simulation, in one place.
 *
 * Units are Unreal Units (1 uu = 1 cm) and seconds, matching the sources cited
 * in DESIGN.md. The renderer draws the scene directly in uu, so nothing here
 * needs converting.
 *
 * Frame: +X right, +Y toward the orange goal, +Z up.
 */

// ---------------------------------------------------------------- simulation

/** Physics runs at a fixed 120 Hz. Jump hold windows are specified in ticks. */
export const TICK_RATE = 120;
export const TICK_DT = 1 / TICK_RATE;

/** Guard against the spiral of death when the tab is backgrounded. */
export const MAX_TICKS_PER_FRAME = 8;

export const GRAVITY = 650; // uu/s^2, downward

// --------------------------------------------------------------------- arena

export const SIDE_WALL_X = 4096;
export const BACK_WALL_Y = 5120;
export const CEILING_Z = 2044;
export const BACK_NET_Y = 6000;

/** |x| + |y| <= this defines the four 45-degree corner walls. */
export const CORNER_PLANE_OFFSET = 8064;
export const CORNER_CATHETUS = 1152;

/** Radius of the cylindrical/spherical fillets at every plane junction. */
export const FILLET_RADIUS = 256;

export const GOAL_HEIGHT = 642.775;
export const GOAL_CENTER_TO_POST = 892.755;
export const GOAL_DEPTH = 880;
/** Ball centre must pass this |y| for a goal to count. */
export const GOAL_THRESHOLD_Y = 5215.5;

// ----------------------------------------------------------------------- car

export const CAR_MASS = 180;
export const CAR_MAX_SPEED = 2300;
export const SUPERSONIC_THRESHOLD = 2200;
/** Once supersonic you stay supersonic while above this, for SUPERSONIC_HOLD. */
export const SUPERSONIC_KEEP = 2100;
export const SUPERSONIC_HOLD = 1.0;
export const CAR_MAX_ANGULAR = 5.5; // rad/s

/** Inertia tensor is CAR_MASS * diag(...). */
export const CAR_INERTIA_DIAG = { x: 751, y: 1334, z: 1836 };

export interface BodyType {
  readonly id: string;
  readonly name: string;
  readonly halfExtents: { x: number; y: number; z: number };
  readonly hitboxOffset: { x: number; y: number; z: number };
  readonly blurb: string;
}

/**
 * Original body shapes. The hitbox is a box, NOT the visual mesh -- see
 * DESIGN.md section 3 for why that matters so much to the feel.
 */
export const BODY_TYPES: readonly BodyType[] = [
  {
    id: 'wedge',
    name: 'Wedge',
    halfExtents: { x: 59.00368881, y: 42.09970474, z: 18.07953644 },
    hitboxOffset: { x: 13.97565993, y: 0, z: 20.75498772 },
    blurb: 'Balanced. Tall nose, forgiving on 50/50s.',
  },
  {
    id: 'slab',
    name: 'Slab',
    halfExtents: { x: 63.0, y: 41.65, z: 15.65 },
    hitboxOffset: { x: 9.0, y: 0, z: 19.9 },
    blurb: 'Long and flat. Reaches further, sits lower.',
  },
  {
    id: 'kite',
    name: 'Kite',
    halfExtents: { x: 59.29, y: 45.55, z: 14.9 },
    hitboxOffset: { x: 9.0, y: 0, z: 15.75 },
    blurb: 'Widest and flattest. Great flat surface for dribbling.',
  },
];

export const DEFAULT_BODY = BODY_TYPES[0];

// ---------------------------------------------------------- ground behaviour

/**
 * Measured throttle acceleration as a function of forward speed (uu/s -> uu/s^2).
 * Piecewise linear; hits exactly zero at 1410 uu/s, which is the published
 * throttle-only top speed. The disabled reference snippet models this as
 * `1550 - v`, which agrees to within ~3% -- a useful cross-check.
 */
export const THROTTLE_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 1600],
  [1400, 160],
  [1410, 0],
];
/** Throttle-only top speed. */
export const DRIVE_SPEED = 1410;
export const BRAKE_FORCE = -3500;
export const COAST_FORCE = -525;
export const BOOST_TARGET_SPEED = 2275;
export const BOOST_ACCEL_GROUND = 991.666;
export const BOOST_ACCEL_AIR = 1060;
export const THROTTLE_ACCEL_AIR = 66.66667;
export const SUPERSONIC_TURN_DRAG = -98.25;
export const THROTTLE_DEADZONE = 0.05;
export const BRAKING_THRESHOLD = -0.001;
export const MIN_DRIVE_SPEED = 10;

/** Coefficients of the turn-damping term of `drive_force_forward`. */
export const TURN_DAMPING = {
  steer: -0.07186693033945346,
  yawRate: -0.05545323728191764,
  lateral: 0.00062552963716722,
};

/** Coefficients of `drive_force_left` -- lateral grip. */
export const LATERAL = {
  steer: 1380.4531378,
  throttle: 7.8281188,
  lateralSpeed: -15.0064029,
  yawRate: 668.1208332,
  /** Grip fades in with speed: a stationary car cannot turn. */
  speedFalloff: 0.001161,
};

/** Yaw servo gain in `drive_torque_up`. */
export const YAW_SERVO_GAIN = 15.0;

/** Presses the car onto whatever surface its wheels are on -- enables wall driving. */
export const STICKY_FORCE = 325;
/** Ticks after a jump during which sticky force is suppressed. */
export const STICKY_SUPPRESS_TICKS = 3;

/**
 * Handbrake. Not published anywhere -- tuned by feel to match the intent:
 * break lateral grip, allow a tighter yaw rate, keep forward speed.
 */
export const HANDBRAKE = {
  gripScale: 0.1,
  curvatureBoost: 1.9,
  /** Extra forward drag while sliding, on top of normal coasting. */
  forwardDrag: -260,
  /** Grip/curvature blend in and out over this many seconds. */
  blendTime: 0.15,
};

/** Suspension: not published; chosen so the hitbox floor sits ~2.7 uu off the ground. */
export const SUSPENSION = {
  restLength: 12,
  maxLength: 25,
  stiffness: 100,
  damping: 8,
  /** Wheel positions in body space, as fractions of the hitbox half-extents. */
  wheelSpreadX: 0.72,
  wheelSpreadY: 1.05,
};

// -------------------------------------------------------- jumping / dodging

export const JUMP_SPEED = 291.667; // instant impulse along the roof normal
export const JUMP_ACCEL = 1458.3333; // held-jump force
export const JUMP_MIN_DURATION = 0.025; // 3 ticks, always applied
export const JUMP_MAX_DURATION = 0.2;
/** Backward kick during the first 3 ticks of a held jump. */
export const JUMP_EARLY_BACK_ACCEL = -510;

export const DODGE_TIMEOUT = 1.25; // window after the first jump
export const DODGE_INPUT_THRESHOLD = 0.5;
export const DODGE_TORQUE_TIME = 0.65;
export const DODGE_FORWARD_TORQUE = 224;
export const DODGE_SIDE_TORQUE = 260;
export const DODGE_IMPULSE = 500;
export const DODGE_Z_DAMPING = 0.35;
export const DODGE_Z_DAMPING_START = 0.15;
export const DODGE_Z_DAMPING_END = 0.21;
/** Pitch input is ignored for this long into a dodge. */
export const DODGE_PITCH_LOCK = 0.3;

// ------------------------------------------------------------- air control

/** Effective moment-of-inertia scalar for the air-control torque servo. */
export const AIR_INERTIA = 10.5;
/** Drive torque coefficients: (roll, pitch, yaw). Roll is by far the strongest. */
export const AIR_TORQUE = { roll: -400, pitch: -130, yaw: 95 };
/** Damping coefficients; pitch/yaw damping is reduced while the stick is held. */
export const AIR_DAMPING = { roll: -50, pitch: -30, yaw: -20 };

// -------------------------------------------------------------------- ball

export const BALL_RADIUS = 91.25;
/** The collision sphere is slightly larger than what is drawn. */
export const BALL_COLLISION_RADIUS = 93.15;
export const BALL_MASS = 30;
export const BALL_RESTITUTION = 0.6;
export const BALL_DRAG = -0.0305;
export const BALL_FRICTION = 2.0;
export const BALL_MAX_SPEED = 6000;
export const BALL_MAX_ANGULAR = 6.0;
export const BALL_INERTIA = 0.4 * BALL_MASS * BALL_RADIUS * BALL_RADIUS;

/**
 * Knots of the extra "kick" impulse applied on car-ball contact, keyed on
 * closing speed. See DESIGN.md 7.2 -- this is the non-physical impulse that
 * makes hits feel powerful and is also the cause of odd wheel-touch angles.
 */
export const BALL_KICK_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.65],
  [500, 0.65],
  [2300, 0.55],
  [4600, 0.3],
];
export const BALL_KICK_MAX_DV = 4600;
/** Flattens the kick direction so hits go forward rather than up. */
export const BALL_KICK_Z_SCALE = 0.35;
/** Reduces the kick when the ball is straight off the nose. */
export const BALL_KICK_FORWARD_BIAS = 0.35;

// -------------------------------------------------------------------- boost

export const BOOST_MAX = 100;
export const BOOST_START = 33;
export const BOOST_CONSUMPTION = 33.3; // per second
export const SMALL_PAD_AMOUNT = 12;
export const BIG_PAD_AMOUNT = 100;
export const SMALL_PAD_RESPAWN = 4;
export const BIG_PAD_RESPAWN = 10;
export const SMALL_PAD_RADIUS = 144;
export const BIG_PAD_RADIUS = 208;
export const PAD_HEIGHT = 165;

export interface BoostPadSpec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly big: boolean;
}

/**
 * All 34 pads. Big pads (z = 73) sit on the outside so committing to one costs
 * you field position; the small pads (z = 70) form refill lanes through the
 * middle for players rotating back.
 */
export const BOOST_PADS: readonly BoostPadSpec[] = (
  [
    [0, -4240, 70],
    [-1792, -4184, 70],
    [1792, -4184, 70],
    [-3072, -4096, 73],
    [3072, -4096, 73],
    [-940, -3308, 70],
    [940, -3308, 70],
    [0, -2816, 70],
    [-3584, -2484, 70],
    [3584, -2484, 70],
    [-1788, -2300, 70],
    [1788, -2300, 70],
    [-2048, -1036, 70],
    [0, -1024, 70],
    [2048, -1036, 70],
    [-3584, 0, 73],
    [-1024, 0, 70],
    [1024, 0, 70],
    [3584, 0, 73],
    [-2048, 1036, 70],
    [0, 1024, 70],
    [2048, 1036, 70],
    [-1788, 2300, 70],
    [1788, 2300, 70],
    [-3584, 2484, 70],
    [3584, 2484, 70],
    [0, 2816, 70],
    [-940, 3308, 70],
    [940, 3308, 70],
    [-3072, 4096, 73],
    [3072, 4096, 73],
    [-1792, 4184, 70],
    [1792, 4184, 70],
    [0, 4240, 70],
  ] as const
).map(([x, y, z]) => ({ x, y, z, big: z === 73 }));

// --------------------------------------------------------------- demolition

export const DEMO_RESPAWN = 3;
/** Attacker-centre to impact point must be within this of the attacker's nose. */
export const DEMO_FORWARD_CONE = (40 * Math.PI) / 180;
/** Impact point to victim centre must fall in this band relative to the nose. */
export const DEMO_IMPACT_MIN = (55 * Math.PI) / 180;
export const DEMO_IMPACT_MAX = (90 * Math.PI) / 180;
/** Below supersonic the same contact is just a bump. */
export const BUMP_IMPULSE_SCALE = 1.0;

// ------------------------------------------------------------------ spawns

export interface SpawnSpec {
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
}

/** Blue-side kickoff spawns; orange mirrors through the origin. */
export const KICKOFF_SPAWNS: readonly SpawnSpec[] = [
  { x: -2048, y: -2560, yaw: Math.PI * 0.25 },
  { x: 2048, y: -2560, yaw: Math.PI * 0.75 },
  { x: -256, y: -3840, yaw: Math.PI * 0.5 },
  { x: 256, y: -3840, yaw: Math.PI * 0.5 },
  { x: 0, y: -4608, yaw: Math.PI * 0.5 },
];

/** Which kickoff spawns are used for a given team size. */
export const KICKOFF_ASSIGNMENT: Record<number, readonly number[]> = {
  1: [4],
  2: [0, 1],
  3: [0, 1, 4],
};

/** Post-goal respawn positions, spread across the goal mouth. */
export const RESPAWN_SPOTS: readonly SpawnSpec[] = [
  { x: -2304, y: -4608, yaw: Math.PI * 0.5 },
  { x: -256, y: -3840, yaw: Math.PI * 0.5 },
  { x: 256, y: -3840, yaw: Math.PI * 0.5 },
  { x: 2304, y: -4608, yaw: Math.PI * 0.5 },
  { x: 0, y: -4608, yaw: Math.PI * 0.5 },
];

export const SPAWN_Z = 17;

// ------------------------------------------------------------------- camera

export const CAMERA_DEFAULTS = {
  fov: 110,
  distance: 270,
  height: 110,
  angle: -4.0, // degrees, pitched down
  stiffness: 0.5,
  swivelSpeed: 5.0,
  transitionSpeed: 1.2,
  ballCam: true,
};

/** Modest FOV widening at supersonic; more than ~6 degrees is nauseating. */
export const SUPERSONIC_FOV_BONUS = 5;
export const SUPERSONIC_FOV_IN_RATE = 6;
export const SUPERSONIC_FOV_OUT_RATE = 3;

// -------------------------------------------------------------------- match

export const MATCH_DURATIONS = [180, 300, 480] as const;
export const DEFAULT_MATCH_DURATION = 300;
export const KICKOFF_COUNTDOWN = 3;
export const GOAL_CELEBRATION = 3.6;

// -------------------------------------------------------------------- teams

export const TEAM_BLUE = 0;
export const TEAM_ORANGE = 1;

/** Original palette: hot cyan vs hot magenta, deliberately not blue/orange. */
export const TEAM_COLORS = [0x18e0ff, 0xff2fa4] as const;
export const TEAM_NAMES = ['SURGE', 'EMBER'] as const;
