import fs from "node:fs";
import path from "node:path";

const AUDIO = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;

/**
 * Copies the sound library (sfx/<role>, music/<mood>) into the bundle's public folder
 * and lists the files by role and mood for the input.
 */
export function linkSounds(soundsDir: string | undefined, publicDir: string) {
  const sounds: Record<string, string[]> = {}, music: Record<string, string[]> = {};
  if (!soundsDir || !fs.existsSync(soundsDir)) return { sounds, music };
  for (const [kind, target] of [["sfx", sounds], ["music", music]] as const) {
    const base = path.join(soundsDir, kind);
    if (!fs.existsSync(base)) continue;
    for (const role of fs.readdirSync(base)) {
      if (!fs.statSync(path.join(base, role)).isDirectory()) continue;
      const files = fs.readdirSync(path.join(base, role)).filter(f => AUDIO.test(f)).sort();
      if (!files.length) continue;
      fs.mkdirSync(path.join(publicDir, "sounds", kind, role), { recursive: true });
      target[role] = files.map(f => {
        fs.copyFileSync(path.join(base, role, f), path.join(publicDir, "sounds", kind, role, f));
        return `sounds/${kind}/${role}/${f}`;
      });
    }
  }
  return { sounds, music };
}
