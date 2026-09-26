import React, { useMemo } from "react";
import { Audio, Video } from "@remotion/media";
import { AbsoluteFill, staticFile } from "remotion";
import { faceOf, useInput } from "../input";
import { theme } from "../theme";
import { buildKeys, CameraContext, CameraLayer, type CamMove, type PanelWindow } from "./camera";
import { LayoutContext, type Occupied } from "./layout";

/** Blocks that take screen space declare it, so the camera and captions can make room. */
export type LayoutDeclaration = { occupied?: Occupied; panel?: PanelWindow };
type WithLayout = { layoutOf?: (props: any) => LayoutDeclaration };

function collect(children: React.ReactNode, out: LayoutDeclaration[]) {
  React.Children.forEach(children, child => {
    if (!React.isValidElement(child)) return;
    if (child.type === React.Fragment) return collect((child.props as { children?: React.ReactNode }).children, out);
    const layoutOf = (child.type as WithLayout).layoutOf;
    if (layoutOf) out.push(layoutOf(child.props));
  });
}

/**
 * The montage root: the author shot with its camera, the voice, and every block above it.
 * Blocks render in order: later children are drawn on top.
 */
export const AstraVideo: React.FC<{ camera?: CamMove[]; children?: React.ReactNode }> = ({ camera = [], children }) => {
  const input = useInput();
  const face = faceOf(input);
  const declarations = useMemo(() => {
    const out: LayoutDeclaration[] = [];
    collect(children, out);
    return out;
  }, [children]);
  const setup = useMemo(() => ({
    keys: buildKeys(camera),
    panels: declarations.flatMap(d => (d.panel ? [d.panel] : [])),
    origin: { x: face.x + face.w / 2, y: face.y + face.h * 0.42 },
  }), [camera, declarations, face.x, face.y, face.w, face.h]);
  const occupied = useMemo(() => declarations.flatMap(d => (d.occupied ? [d.occupied] : [])), [declarations]);

  return (
    <CameraContext.Provider value={setup}>
      <LayoutContext.Provider value={occupied}>
        <AbsoluteFill style={{ backgroundColor: theme.color.ink }}>
          <CameraLayer>
            <Video src={staticFile(input.video)} muted={Boolean(input.voice)} objectFit="cover" style={{ width: "100%", height: "100%" }} />
          </CameraLayer>
          {children}
          {input.voice ? <Audio src={staticFile(input.voice)} /> : null}
        </AbsoluteFill>
      </LayoutContext.Provider>
    </CameraContext.Provider>
  );
};
