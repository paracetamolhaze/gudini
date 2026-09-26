import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

const CYRILLIC = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116";
const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

const subsets = (family: string, file: string, weight: string) =>
  [["cyrillic", CYRILLIC], ["latin", LATIN]].map(([subset, unicodeRange]) =>
    loadFont({ family, url: staticFile(`fonts/${file}-${subset}-${weight}-normal.woff2`), weight, unicodeRange, display: "block" }));

/** Loaded once per bundle; every block uses these families through the theme. */
export const fontsReady = Promise.all([
  loadFont({ family: "Oswald", url: staticFile("fonts/Oswald-Bold.ttf"), weight: "700", display: "block" }),
  loadFont({ family: "Anton", url: staticFile("fonts/Anton-Regular.ttf"), weight: "400", display: "block" }),
  loadFont({ family: "Montserrat", url: staticFile("fonts/Montserrat-Black.ttf"), weight: "900", display: "block" }),
  ...subsets("Montserrat", "montserrat", "600"),
  ...subsets("Montserrat", "montserrat", "700"),
  ...subsets("Montserrat", "montserrat", "800"),
  ...subsets("Caveat", "caveat", "700"),
]);
