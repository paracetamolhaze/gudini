import { staticFile } from "remotion";
import { useInput } from "../input";

/** Resolves an asset by its name from the input, a public-folder path, or a full URL. */
export function useAsset() {
  const { assets } = useInput();
  return (name: string): string => {
    if (/^https?:\/\//.test(name)) return name;
    return staticFile(assets[name] ?? name);
  };
}
