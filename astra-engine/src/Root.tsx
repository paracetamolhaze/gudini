import React from "react";
import { Composition } from "remotion";
import { AstraComposition } from "./AstraComposition";
import { astraInputSchema, type AstraInput } from "./input";
import devInput from "./dev-input.json";

export const Root: React.FC = () => (
  <Composition
    id="Astra"
    component={AstraComposition}
    schema={astraInputSchema}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={300}
    defaultProps={devInput as AstraInput}
    calculateMetadata={({ props }) => ({
      fps: props.fps,
      durationInFrames: Math.max(1, Math.round(props.duration * props.fps)),
    })}
  />
);
