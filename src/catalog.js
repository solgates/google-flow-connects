'use strict';

const VOICES = [
  { name: 'Achernar', gender: 'Female', style: 'soft, high pitch', uiVerified: true },
  { name: 'Achird', gender: 'Male', style: 'friendly, mid pitch', uiVerified: true },
  { name: 'Algenib', gender: 'Male', style: 'gravelly, low pitch', uiVerified: true },
  { name: 'Algieba', gender: 'Male', style: 'easy-going, mid-low pitch', uiVerified: true },
  { name: 'Alnilam', gender: 'Male', style: 'firm, mid-low pitch', uiVerified: true },
  { name: 'Aoede', gender: 'Female', style: 'breezy, mid pitch', uiVerified: true },
  { name: 'Autonoe', gender: 'Female', style: 'bright, mid pitch', uiVerified: true },
  { name: 'Callirrhoe', gender: 'Female', style: 'easy-going, mid pitch', uiVerified: true },
  { name: 'Charon', gender: 'Male', style: 'informative, lower pitch', uiVerified: true },
  { name: 'Despina', gender: 'Female', style: 'smooth, mid pitch', uiVerified: true },
  { name: 'Enceladus', gender: 'Male', style: 'breathy, lower pitch', uiVerified: true },
  { name: 'Erinome', gender: 'Female', style: 'clear, mid pitch', uiVerified: false },
  { name: 'Fenrir', gender: 'Male', style: 'excitable, lower-mid pitch', uiVerified: false },
  { name: 'Gacrux', gender: 'Female', style: 'mature, mid pitch', uiVerified: false },
  { name: 'Iapetus', gender: 'Male', style: 'clear, lower-mid pitch', uiVerified: false },
  { name: 'Kore', gender: 'Female', style: 'firm, mid pitch', uiVerified: false },
  { name: 'Laomedeia', gender: 'Female', style: 'upbeat, mid pitch', uiVerified: false },
  { name: 'Leda', gender: 'Female', style: 'youthful, high pitch', uiVerified: false },
  { name: 'Orus', gender: 'Male', style: 'firm, lower-mid pitch', uiVerified: false },
  { name: 'Puck', gender: 'Male', style: 'upbeat, mid pitch', uiVerified: false },
  { name: 'Pulcherrima', gender: 'Female', style: 'forward, mid pitch', uiVerified: false },
  { name: 'Rasalgethi', gender: 'Male', style: 'informative, mid pitch', uiVerified: false },
  { name: 'Sadachbia', gender: 'Male', style: 'lively, mid pitch', uiVerified: false },
  { name: 'Sadaltager', gender: 'Male', style: 'knowledgeable, mid pitch', uiVerified: false },
  { name: 'Schedar', gender: 'Male', style: 'even, lower-mid pitch', uiVerified: false },
  { name: 'Sulafat', gender: 'Female', style: 'warm, mid pitch', uiVerified: false },
  { name: 'Umbriel', gender: 'Male', style: 'easy-going, lower-mid pitch', uiVerified: false },
  { name: 'Vindemiatrix', gender: 'Female', style: 'gentle, mid pitch', uiVerified: false },
  { name: 'Zephyr', gender: 'Female', style: 'bright, higher pitch', uiVerified: false },
  { name: 'Zubenelgenubi', gender: 'Male', style: 'casual, lower-mid pitch', uiVerified: false },
];

const ASSET_CATEGORIES = {
  semua: ['Semua', 'All'],
  all: ['Semua', 'All'],
  gambar: ['Gambar', 'Images', 'Image'],
  image: ['Gambar', 'Images', 'Image'],
  images: ['Gambar', 'Images', 'Image'],
  video: ['Video', 'Videos'],
  videos: ['Video', 'Videos'],
  suara: ['Suara', 'Voice', 'Voices', 'Audio'],
  voice: ['Suara', 'Voice', 'Voices', 'Audio'],
  voices: ['Suara', 'Voice', 'Voices', 'Audio'],
  audio: ['Suara', 'Voice', 'Voices', 'Audio'],
  karakter: ['Karakter', 'Character', 'Characters', 'Ingredients'],
  character: ['Karakter', 'Character', 'Characters', 'Ingredients'],
  characters: ['Karakter', 'Character', 'Characters', 'Ingredients'],
  avatar: ['Avatar', 'Avatars'],
  avatars: ['Avatar', 'Avatars'],
  uploaded: ['File yang diupload', 'File yang diunggah', 'File yang di...', 'Uploaded files', 'Uploaded', 'Uploads'],
  file: ['File yang diupload', 'File yang diunggah', 'File yang di...', 'Uploaded files', 'Uploaded', 'Uploads'],
  files: ['File yang diupload', 'File yang diunggah', 'File yang di...', 'Uploaded files', 'Uploaded', 'Uploads'],
};

function normalizeCategoryKey(category) {
  if (!category) return 'semua';
  const key = String(category).trim().toLowerCase();
  if (ASSET_CATEGORIES[key]) return key;
  for (const [canon, labels] of Object.entries(ASSET_CATEGORIES)) {
    if (labels.some((l) => l.toLowerCase() === key)) return canon;
  }
  return 'semua';
}

function getCategoryLabels(category) {
  const key = normalizeCategoryKey(category);
  return ASSET_CATEGORIES[key] || ASSET_CATEGORIES.semua;
}

function findVoices(query) {
  if (!query) return VOICES;
  const q = String(query).trim().toLowerCase();
  return VOICES.filter(
    (v) =>
      v.name.toLowerCase().includes(q) ||
      v.gender.toLowerCase().includes(q) ||
      v.style.toLowerCase().includes(q)
  );
}

function resolveVoiceExact(name) {
  if (!name) return null;
  const q = String(name).trim().toLowerCase();
  return (
    VOICES.find((v) => v.name.toLowerCase() === q) ||
    VOICES.find((v) => v.name.toLowerCase().startsWith(q)) ||
    null
  );
}

module.exports = {
  VOICES,
  ASSET_CATEGORIES,
  normalizeCategoryKey,
  getCategoryLabels,
  findVoices,
  resolveVoiceExact,
};
