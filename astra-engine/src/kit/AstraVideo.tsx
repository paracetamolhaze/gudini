import React, { useMemo } from "react";
import { Audio, Video } from "@remotion/media";
import { AbsoluteFill, staticFile } from "remotion";
import { faceOf, useInput, type AstraInput } from "../input";
import { theme } from "../theme";
import { buildKeys, CameraContext, CameraLayer, type CamMove, type PanelWindow } from "./camera";
import { LayoutContext, type Occupied } from "./layout";
import { Clip, useClipOffset } from "./time";

/** Blocks that take screen space declare it, so the camera and captions can make room. */
export type LayoutDeclaration = { occupied?: Occupied; panel?: PanelWindow };
type WithLayout = { layoutOf?: (props: any, input?: AstraInput) => LayoutDeclaration };

function collect(children: React.ReactNode, out: LayoutDeclaration[], input: AstraInput) {
  React.Children.forEach(children, child => {
    if (!React.isValidElement(child)) return;
    if (child.type === React.Fragment) return collect((child.props as { children?: React.ReactNode }).children, out, input);
    const layoutOf = (child.type as WithLayout).layoutOf;
    if (layoutOf) out.push(layoutOf(child.props, input));
  });
}

const BlurredFill: React.FC = () => {
  const input = useInput();
  const offset = useClipOffset();
  return (
    <AbsoluteFill>
      <Video src={staticFile(input.video)} muted trimBefore={offset} objectFit="cover"
        style={{ width: "100%", height: "100%", scale: "1.3", filter: "blur(36px) brightness(0.55) saturate(1.2)" }} />
    </AbsoluteFill>
  );
};

/** Back-to-back panels that move the author the same way become one move: the author stays up between them. */
function mergePanels(panels: PanelWindow[]): PanelWindow[] {
  const merged: PanelWindow[] = [];
  for (const p of [...panels].sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && p.from - last.to < 0.8 && last.dx === p.dx && last.dy === p.dy && last.zoom === p.zoom) last.to = Math.max(last.to, p.to);
    else merged.push({ ...p });
  }
  return merged;
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
    collect(children, out, input);
    return out;
  }, [children, input]);
  const setup = useMemo(() => ({
    keys: buildKeys(camera),
    panels: mergePanels(declarations.flatMap(d => (d.panel ? [d.panel] : []))),
    origin: { x: face.x + face.w / 2, y: face.y + face.h * 0.42 },
  }), [camera, declarations, face.x, face.y, face.w, face.h]);
  const occupied = useMemo(() => declarations.flatMap(d => (d.occupied ? [d.occupied] : [])), [declarations]);

  return (
    <CameraContext.Provider value={setup}>
      <LayoutContext.Provider value={occupied}>
        <AbsoluteFill style={{ backgroundColor: theme.color.ink }}>
          {/* When the author moves aside, the space left behind shows the same shot blurred, not black. */}
          {setup.panels.map((p, i) => (
            <Clip key={i} from={Math.max(0, p.from - 0.1)} to={p.to + 0.1} name="Blurred fill">
              <BlurredFill />
            </Clip>
          ))}
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
