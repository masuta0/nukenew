// utils/face.js
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const MODELS_DIR = path.join(__dirname, 'models');

let referenceDescriptor = null;

// 初期化（モデル読み込み）
async function initFaceRecognition() {
  if (!fs.existsSync(MODELS_DIR)) {
    throw new Error(`モデルフォルダが存在しません: ${MODELS_DIR}`);
  }

  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);

}

// 顔登録（基準画像を読み込む。localPath はローカルファイルパスまたはURL）
async function registerFace(localPath) {
  let buffer;

  // URLの場合はfetchして取得
  if (typeof localPath === 'string' && (localPath.startsWith('http://') || localPath.startsWith('https://'))) {
    const res = await fetch(localPath);
    if (!res.ok) {
      throw new Error(`URL から画像を取得できませんでした: ${res.status}`);
    }
    buffer = await res.buffer();
  } else {
    if (!fs.existsSync(localPath)) {
      throw new Error(`ファイルが見つかりません: ${localPath}`);
    }
    buffer = fs.readFileSync(localPath);
  }

  const img = await canvas.loadImage(buffer);
  const detection = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    throw new Error('顔が検出できませんでした。別の画像を試してください。');
  }

  referenceDescriptor = detection.descriptor;
  return true;
}

// 類似顔判定：引数は URL またはローカルファイルパスのいずれかを受け付けます
async function isSimilarFace(imgPathOrUrl, threshold = 0.2) {
  if (!referenceDescriptor) {
    return false;
  }

  let buffer;
  // URL の可能性を判定（単純判定）
  if (typeof imgPathOrUrl === 'string' && (imgPathOrUrl.startsWith('http://') || imgPathOrUrl.startsWith('https://'))) {
    const res = await fetch(imgPathOrUrl);
    if (!res.ok) {
      return false;
    }
    buffer = await res.buffer();
  } else {
    // ローカルファイルパスとして扱う
    if (!fs.existsSync(imgPathOrUrl)) {
      return false;
    }
    buffer = fs.readFileSync(imgPathOrUrl);
  }

  const img = await canvas.loadImage(buffer);

  const detection = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    return false;
  }

  const distance = faceapi.euclideanDistance(referenceDescriptor, detection.descriptor);

  return distance < threshold;
}

module.exports = {
  initFaceRecognition,
  registerFace,
  isSimilarFace
};
