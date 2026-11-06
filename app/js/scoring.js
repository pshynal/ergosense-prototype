// ErgoSense scoring engine.
// Turns MediaPipe pose landmarks (and optional detected objects) from one
// side-view photo into ergonomic findings, a 0-100 score and a risk class.
// Thresholds follow RULA and ROSA conventions, adapted for a single 2D side view.
// Pure functions only: no DOM, no network, so it runs in the browser and in Node tests.

export const RULES_VERSION = 'ergosense-rules 1.0 (RULA/ROSA-based)';

// MediaPipe Pose landmark indices
export const LM = {
  nose: 0, leftEye: 2, rightEye: 5, leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16, leftIndex: 19, rightIndex: 20,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28
};

// Average seated adult shoulder-to-hip length, used to turn pixels into rough centimetres.
const TORSO_CM = 52;
const MIN_VISIBILITY = 0.5;
const LEG_VISIBILITY = 0.8;

export const AREAS = ['Sitting posture', 'Monitor height and distance', 'Keyboard and mouse', 'Chair and desk'];
const SEV_RANK = { Low: 0, Medium: 1, High: 2 };
const PENALTY = { Low: 0, Medium: 8, High: 18 };

const deg = r => r * 180 / Math.PI;
const round = v => Math.round(v);

// Signed angle (degrees) of vector a->b from straight up. Positive = leaning towards the facing direction.
function angleFromUp(a, b, facing) {
  const dx = (b.x - a.x) * facing, dy = b.y - a.y;
  return deg(Math.atan2(dx, -dy));
}
// Angle (degrees) of vector a->b from straight down, unsigned.
function angleFromDown(a, b) {
  return Math.abs(deg(Math.atan2(b.x - a.x, b.y - a.y)));
}
// Interior angle at b for points a-b-c, degrees 0..180.
export function interiorAngle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y, m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (!m) return NaN;
  return deg(Math.acos(Math.max(-1, Math.min(1, dot / m))));
}
// Angle between two direction vectors a1->a2 and b1->b2, degrees 0..180.
function between(a1, a2, b1, b2) {
  return interiorAngle({ x: a2.x - a1.x, y: a2.y - a1.y }, { x: 0, y: 0 }, { x: b2.x - b1.x, y: b2.y - b1.y });
}

const band = (v, lowMax, medMax) => v <= lowMax ? 'Low' : v <= medMax ? 'Medium' : 'High';
const rangeBand = (v, okMin, okMax, medMin, medMax) =>
  v >= okMin && v <= okMax ? 'Low' : v >= medMin && v <= medMax ? 'Medium' : 'High';

// Convert normalised landmarks to pixel space so angles are not distorted by the image aspect ratio.
function toPixels(landmarks, width, height) {
  return landmarks.map(p => ({ x: p.x * width, y: p.y * height, v: p.visibility ?? 1 }));
}

// Pick the body side facing the camera and the direction the person faces.
export function pickSide(px) {
  const sideScore = s => ['Ear', 'Shoulder', 'Elbow', 'Wrist', 'Hip', 'Knee']
    .reduce((a, j) => a + px[LM[s + j]].v, 0);
  const side = sideScore('left') >= sideScore('right') ? 'left' : 'right';
  const ear = px[LM[side + 'Ear']], nose = px[LM.nose];
  const facing = nose.x >= ear.x ? 1 : -1;
  return { side, facing };
}

// A joint counts only if the model is confident and it lies inside the photo
// (MediaPipe also guesses joints hidden behind the desk or outside the frame).
const seen = (p, w, h) => !!p && p.v >= MIN_VISIBILITY && p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;

// Quality checks: is there a person, is it a side view, are the core joints visible?
// Hips and knees are optional: photos are often cropped at desk height.
export function checkQuality(px, side, w = Infinity, h = Infinity) {
  const j = name => px[LM[side + name]];
  const core = ['Ear', 'Shoulder', 'Elbow'].map(j);
  const visibility = core.reduce((a, p) => a + p.v, 0) / core.length;
  const hipSeen = seen(j('Hip'), w, h);
  // Torso length sets the pixel-to-cm scale; without the hip, estimate it from ear-to-shoulder distance.
  const torso = hipSeen
    ? Math.hypot(j('Shoulder').x - j('Hip').x, j('Shoulder').y - j('Hip').y)
    : 2.4 * Math.hypot(j('Shoulder').x - j('Ear').x, j('Shoulder').y - j('Ear').y);
  const shoulderSpread = Math.abs(px[LM.leftShoulder].x - px[LM.rightShoulder].x);
  const issues = [];
  if (!core.every(p => seen(p, w, h))) issues.push('Your head, shoulder or elbow is hidden. Make sure your upper body on the camera side is fully in the photo.');
  if (torso > 0 && shoulderSpread / torso > 0.55) issues.push('This looks like a front view. Take the photo from your side, level with the desk.');
  return { visibility, torso, hipSeen, issues, ok: issues.length === 0 };
}

function finding(area, key, label, value, unit, severity, message, recommendation) {
  return { area, key, label, value: Number.isFinite(value) ? round(value) : null, unit, severity, message, recommendation };
}

// objects: [{ label: 'tv'|'laptop'|'keyboard'|'mouse'|'chair', box: { x, y, width, height } }] in pixels.
export function analysePosture({ landmarks, width, height, objects = [] }) {
  if (!landmarks || landmarks.length < 29) {
    return { ok: false, issues: ['No person was found in the photo. Make sure your whole upper body and knees are in the frame.'] };
  }
  const px = toPixels(landmarks, width, height);
  const { side, facing } = pickSide(px);
  const q = checkQuality(px, side, width, height);
  if (!q.ok) return { ok: false, issues: q.issues, visibility: q.visibility };

  const j = name => px[LM[side + name]];
  const ear = j('Ear'), sh = j('Shoulder'), el = j('Elbow'), wr = j('Wrist'), idx = j('Index'),
    hip = j('Hip'), knee = j('Knee'), ankle = j('Ankle'), eye = px[LM[side + 'Eye']];
  const ok = p => seen(p, width, height);
  const cm = pxDist => pxDist / q.torso * TORSO_CM;
  const f = [], notScored = [];

  // Sitting posture
  const neck = angleFromUp(sh, ear, facing);
  f.push(finding('Sitting posture', 'neck', 'Neck flexion', neck, '°', band(neck, 15, 25),
    neck > 25 ? 'Your head sits well forward of your shoulders.' : neck > 15 ? 'Your head leans slightly forward.' : 'Head is balanced over your shoulders.',
    'Sit back and bring your head over your shoulders; raise the screen if you look down.'));
  if (ok(hip)) {
    const trunk = angleFromUp(hip, sh, facing);
    const trunkSev = trunk > 20 ? 'High' : trunk > 10 ? 'Medium' : trunk < -25 ? 'Medium' : 'Low';
    f.push(finding('Sitting posture', 'trunk', trunk >= 0 ? 'Trunk lean forward' : 'Trunk recline', Math.abs(trunk), '°', trunkSev,
      trunk > 10 ? 'You lean forward away from the backrest.' : trunk < -25 ? 'You recline far back, which pulls your head forward.' : 'Upright or slightly reclined, supported by the backrest.',
      'Slide back so your lower back touches the backrest, reclined about 100–110°.'));
  } else notScored.push('Trunk lean, hip and knee angles (hips not visible in the photo)');
  const upperArm = angleFromDown(sh, el);
  f.push(finding('Keyboard and mouse', 'upperArm', 'Upper arm raised', upperArm, '°', band(upperArm, 20, 45),
    upperArm > 20 ? 'Your elbow reaches forward, loading the shoulder.' : 'Elbows close to your body.',
    'Bring the keyboard and mouse closer so your elbows stay by your sides.'));
  if (ok(wr)) {
    const elbow = interiorAngle(sh, el, wr);
    f.push(finding('Keyboard and mouse', 'elbow', 'Elbow angle', elbow, '°', rangeBand(elbow, 80, 120, 60, 140),
      elbow < 80 ? 'Your forearms angle up steeply; the desk or keyboard may be too high.' : elbow > 120 ? 'Your arms are stretched; the keyboard may be too far.' : 'Elbows at a comfortable angle.',
      'Set desk or chair height so elbows are at about 90–110° with relaxed shoulders.'));
  } else notScored.push('Elbow and wrist angles (wrist not visible)');
  if (ok(wr) && ok(idx)) {
    const wrist = between(el, wr, wr, idx);
    f.push(finding('Keyboard and mouse', 'wrist', 'Wrist bend', wrist, '°', band(wrist, 15, 30),
      wrist > 15 ? 'Your wrist bends while typing or using the mouse.' : 'Wrists are fairly straight.',
      'Lower the keyboard feet and keep wrists straight; consider a flat keyboard.'));
  }
  // Knees are often hidden by the desk, and the model still guesses them with fair confidence.
  // Score legs only with high confidence and a seated shape (knee clearly in front of the hip).
  const legOk = p => ok(p) && p.v >= LEG_VISIBILITY;
  const seated = legOk(knee) && (knee.x - hip.x) * facing >= 0.35 * q.torso;
  if (ok(hip) && legOk(knee) && !seated) notScored.push('Hip and knee angles (legs hidden by the desk or not in a seated position)');
  else if (ok(hip) && !legOk(knee)) notScored.push('Hip and knee angles (knees not clearly visible)');
  if (ok(hip) && seated) {
    const hipA = interiorAngle(sh, hip, knee);
    f.push(finding('Chair and desk', 'hip', 'Hip angle', hipA, '°', rangeBand(hipA, 90, 120, 80, 135),
      hipA < 90 ? 'You are folded forward at the hips.' : 'Hip angle is open enough.',
      'Recline the backrest slightly and sit fully back in the chair.'));
  }
  if (ok(hip) && seated && legOk(ankle)) {
    const kneeA = interiorAngle(hip, knee, ankle);
    f.push(finding('Chair and desk', 'knee', 'Knee angle', kneeA, '°', rangeBand(kneeA, 80, 110, 70, 125),
      kneeA < 80 ? 'Knees are bent sharply; the seat may be too low or feet tucked under.' : kneeA > 110 ? 'Legs are stretched out; the seat may be too high or feet unsupported.' : 'Seat height suits your legs.',
      'Adjust seat height so feet rest flat with knees at about 90°; use a footrest if needed.'));
  }

  // Workstation objects (COCO labels from the object detector)
  // Only screens in front of the person count, so a monitor behind them is ignored.
  const inFront = objects.filter(o => (o.box.x + o.box.width / 2 - eye.x) * facing > 0);
  const screen = pickObject(inFront, ['tv', 'laptop'], eye);
  if (screen) {
    const top = screen.box.y, near = facing > 0 ? screen.box.x : screen.box.x + screen.box.width;
    const below = cm(top - eye.y);
    f.push(finding('Monitor height and distance', 'monitorHeight', below >= 0 ? 'Screen top below eye level' : 'Screen top above eye level', Math.abs(below), 'cm',
      below > 15 ? 'High' : below > 8 || below < -8 ? 'Medium' : 'Low',
      below > 8 ? 'The screen is low, so you look down.' : below < -8 ? 'The screen is high, so you tilt your head back.' : 'Top of the screen is near eye level.',
      'Set the top line of text at or just below eye level; use a stand or riser.'));
    const dist = cm(Math.abs(near - eye.x));
    // Depth from one 2D side photo is rough, so distance is an estimate and capped at Medium.
    f.push(finding('Monitor height and distance', 'monitorDistance', 'Screen distance (estimate)', dist, 'cm', dist >= 50 && dist <= 75 ? 'Low' : 'Medium',
      dist < 50 ? 'The screen is close to your eyes.' : dist > 75 ? 'The screen is far away; you may lean in.' : 'Screen at about arm\'s length.',
      'Place the screen about an arm\'s length away (50–75 cm).'));
    if (screen.label === 'laptop' && !objects.some(o => o.label === 'tv')) {
      f.push(finding('Monitor height and distance', 'laptopOnly', 'Laptop screen without stand', null, '', 'Medium',
        'Working on a laptop screen keeps it too low.', 'Use a laptop stand with a separate keyboard and mouse, or an external monitor.'));
    }
  } else {
    f.push(finding('Monitor height and distance', 'monitorUnknown', 'Screen not detected', null, '', 'Low',
      'No screen was found in the photo, so screen height and distance are not scored.', 'Retake the photo with the screen in view, or answer the monitor questions in the self-assessment.'));
  }
  const kb = pickObject(objects, ['keyboard'], el);
  if (kb) {
    const above = cm(el.y - (kb.box.y + kb.box.height / 2));
    f.push(finding('Keyboard and mouse', 'keyboardHeight', above >= 0 ? 'Keyboard above elbow' : 'Keyboard below elbow', Math.abs(above), 'cm',
      above > 8 ? 'High' : above > 4 ? 'Medium' : 'Low',
      above > 4 ? 'The keyboard sits above elbow height, raising your shoulders.' : 'Keyboard at about elbow height.',
      'Lower the desk or raise the chair so the keyboard is at elbow height.'));
  }
  const mouse = ok(wr) && pickObject(objects, ['mouse'], wr);
  if (mouse) {
    const reach = cm(Math.abs((mouse.box.x + mouse.box.width / 2) - el.x));
    f.push(finding('Keyboard and mouse', 'mouseReach', 'Mouse reach', reach, 'cm', band(reach, 30, 42),
      reach > 30 ? 'The mouse is far forward of your elbow.' : 'Mouse within easy reach.',
      'Keep the mouse close, beside the keyboard.'));
  }

  return { ok: true, side, facing, visibility: q.visibility, notScored, ...summarise(f) };
}

function pickObject(objects, labels, near) {
  const c = objects.filter(o => labels.includes(o.label));
  if (!c.length) return null;
  return c.sort((a, b) => dist(center(a.box), near) - dist(center(b.box), near))[0];
}
const center = b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function maxSeverity(list) {
  return list.reduce((m, s) => SEV_RANK[s] > SEV_RANK[m] ? s : m, 'Low');
}

// Score: 100 minus penalties per finding. Class: High if any High finding, Medium if any Medium.
export function summarise(findings) {
  const scored = findings.filter(x => x.value !== null || x.key === 'laptopOnly');
  const score = Math.max(0, Math.min(100, 100 - scored.reduce((a, x) => a + PENALTY[x.severity], 0)));
  const areas = AREAS.map(area => {
    const inArea = findings.filter(x => x.area === area && (x.value !== null || x.key === 'laptopOnly'));
    return { area, severity: inArea.length ? maxSeverity(inArea.map(x => x.severity)) : null, count: inArea.length };
  });
  const riskClass = maxSeverity(scored.map(x => x.severity));
  return { findings, areas, score, riskClass, rulesVersion: RULES_VERSION };
}

// Self-assessment: answers keyed 'step-question' with 'Yes' | 'Partly' | 'No'.
export function scoreSelfAssessment(answers) {
  const vals = Object.values(answers).filter(Boolean);
  if (!vals.length) return null;
  const pts = vals.reduce((a, v) => a + (v === 'Yes' ? 1 : v === 'Partly' ? 0.5 : 0), 0);
  const score = Math.round(pts / vals.length * 100);
  return { score, riskClass: score >= 80 ? 'Low' : score >= 60 ? 'Medium' : 'High', failed: Object.entries(answers).filter(([, v]) => v === 'No' || v === 'Partly').map(([k]) => k) };
}

// Combined result: AI score weighted 70%, self-assessment 30%; the class never drops below the AI class.
export function combine(ai, self) {
  if (ai && self) {
    const score = Math.round(ai.score * 0.7 + self.score * 0.3);
    const fromScore = score >= 80 ? 'Low' : score >= 60 ? 'Medium' : 'High';
    return { score, riskClass: maxSeverity([ai.riskClass, fromScore]) };
  }
  const one = ai || self;
  return one ? { score: one.score, riskClass: one.riskClass } : null;
}
