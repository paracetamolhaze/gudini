// Prepares the owner's sound library once (levels, trimmed silence), e.g. while building the worker image.
// npx tsx director/prepare-sounds.ts <library dir> <prepared dir>
import { linkSounds } from "./sounds";

const [library, prepared] = process.argv.slice(2);
const result = linkSounds(library, prepared, prepared);
const count = Object.values(result.sounds).reduce((sum, files) => sum + files.length, 0) + Object.values(result.music).reduce((sum, files) => sum + files.length, 0);
console.log(`prepared ${count} sounds into ${prepared}`);
