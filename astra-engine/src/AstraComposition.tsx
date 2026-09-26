import React, { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { fontsReady } from "./fonts";
import { InputContext, type AstraInput } from "./input";
import { Montage } from "./montage/Montage";

/** Waits for fonts (text is measured with them), then renders the montage Astra wrote. */
export const AstraComposition: React.FC<AstraInput> = (input) => {
  const [handle] = useState(() => delayRender("Loading Astra fonts"));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    fontsReady.then(() => setReady(true)).catch((error) => cancelRender(error));
  }, []);
  useEffect(() => {
    if (ready) continueRender(handle);
  }, [ready, handle]);
  if (!ready) return null;
  return (
    <InputContext.Provider value={input}>
      <Montage />
    </InputContext.Provider>
  );
};
