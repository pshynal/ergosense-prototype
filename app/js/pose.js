// Runs MediaPipe Pose Landmarker and Object Detector in the browser.
// The photo is processed on the device: only landmarks and detected boxes are returned,
// and the image itself is never uploaded.

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const OBJECT_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
export const MODEL_VERSION = 'MediaPipe Pose Landmarker full (float16 v1) + EfficientDet-Lite0';

const WORKSTATION_LABELS = ['tv', 'laptop', 'keyboard', 'mouse', 'chair'];
let ready = null;

// Loads both models once; later calls reuse them.
export function loadModels(onStatus = () => {}) {
  if (ready) return ready;
  ready = (async () => {
    onStatus('Loading the AI model (about 10 MB, first time only)…');
    const { FilesetResolver, PoseLandmarker, ObjectDetector } = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const [pose, objects] = await Promise.all([
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
        runningMode: 'IMAGE', numPoses: 1
      }),
      ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: OBJECT_MODEL, delegate: 'GPU' },
        runningMode: 'IMAGE', scoreThreshold: 0.3, maxResults: 10
      })
    ]);
    return { pose, objects };
  })();
  // Give up after 60 s so the screen never stays on "analysing" if the model can't download.
  ready = Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Loading the AI model timed out')), 60000))]);
  ready.catch(() => { ready = null; });
  return ready;
}

// image: a loaded HTMLImageElement. Returns { landmarks, objects, width, height, ms }.
export async function detect(image, onStatus = () => {}) {
  const { pose, objects } = await loadModels(onStatus);
  onStatus('Detecting body keypoints…');
  const t0 = performance.now();
  const p = pose.detect(image);
  onStatus('Locating screen, keyboard and mouse…');
  const o = objects.detect(image);
  const found = (o.detections || [])
    .map(d => ({ label: d.categories[0]?.categoryName, score: d.categories[0]?.score, box: { x: d.boundingBox.originX, y: d.boundingBox.originY, width: d.boundingBox.width, height: d.boundingBox.height } }))
    .filter(d => WORKSTATION_LABELS.includes(d.label));
  return {
    landmarks: p.landmarks?.[0] || null,
    objects: found,
    width: image.naturalWidth,
    height: image.naturalHeight,
    ms: Math.round(performance.now() - t0)
  };
}

// Reads a File into an <img> without uploading it anywhere.
export function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file could not be read as an image. Use a JPG or PNG photo.')); };
    img.src = url;
  });
}
