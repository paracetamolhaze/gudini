import React, { useMemo } from "react";
import { geoAlbersUsa, geoNaturalEarth1, geoPath, type GeoProjection } from "d3-geo";
import { feature } from "topojson-client";
import { AbsoluteFill, interpolate, spring } from "remotion";
import countriesTopo from "world-atlas/countries-110m.json";
import statesTopo from "us-atlas/states-10m.json";
import { theme } from "../theme";
import type { LayoutDeclaration } from "./AstraVideo";
import { BlockSfx, type SfxRole } from "./audio";
import { EASE_IN_OUT } from "./motion";
import { Clip, useClip } from "./time";

type Props = {
  from: number;
  to: number;
  /** usa: states map; world: countries map. */
  region: "usa" | "world";
  /** The place to fly to. */
  lat: number;
  lon: number;
  /** Short name on the pin, e.g. «Калифорния». */
  label: string;
  /** English name of the state or country to light up: "California", "Russia". */
  highlight?: string;
  /** How close the camera flies in; 2.5–4 for a state, 3–6 for a country. */
  zoom?: number;
  sfx?: SfxRole | false;
};

type Feature = { type: string; properties: { name?: string }; geometry: unknown };
const BOX = { x: 40, y: 520, w: 1000, h: 820 };

function useMap(region: Props["region"]) {
  return useMemo(() => {
    const topo = (region === "usa" ? statesTopo : countriesTopo) as any;
    const collection = feature(topo, region === "usa" ? topo.objects.states : topo.objects.countries) as unknown as { features: Feature[] };
    const projection: GeoProjection = (region === "usa" ? geoAlbersUsa() : geoNaturalEarth1()) as GeoProjection;
    projection.fitExtent([[BOX.x, BOX.y], [BOX.x + BOX.w, BOX.y + BOX.h]], collection as any);
    const path = geoPath(projection);
    return { features: collection.features.map(f => ({ name: f.properties.name ?? "", d: path(f as any) ?? "" })), projection };
  }, [region]);
}

const Body: React.FC<Omit<Props, "from" | "to" | "sfx">> = ({ region, lat, lon, label, highlight, zoom = region === "usa" ? 3 : 4 }) => {
  const { frame, fps, lengthFrames } = useClip();
  const { features, projection } = useMap(region);
  const point = projection([lon, lat]) ?? [BOX.x + BOX.w / 2, BOX.y + BOX.h / 2];
  const fly = interpolate(frame, [0.35 * fps, 1.9 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IN_OUT });
  // The place glides to the center of the frame while the map grows around it.
  const scale = 1 + (zoom - 1) * fly;
  const target = { x: 540, y: 930 };
  const screen = { x: point[0] + (target.x - point[0]) * fly, y: point[1] + (target.y - point[1]) * fly };
  const tx = screen.x - point[0] * scale, ty = screen.y - point[1] * scale;
  const fade = Math.min(
    interpolate(frame, [0, 0.25 * fps], [0, 1], { extrapolateRight: "clamp" }),
    interpolate(frame, [lengthFrames - 0.25 * fps, lengthFrames], [1, 0], { extrapolateLeft: "clamp" }),
  );
  const pinDrop = spring({ frame: frame - 1.5 * fps, fps, config: { damping: 10, stiffness: 160, mass: 0.7 } });
  const ring = ((frame - 1.7 * fps) / fps) % 1.2;
  const lit = interpolate(frame, [0.9 * fps, 1.6 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: fade, background: "radial-gradient(circle at 50% 45%, #16223a 0%, #0a0f1b 70%)" }}>
      <AbsoluteFill style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)", backgroundSize: "60px 60px" }} />
      <svg width={1080} height={1920} style={{ position: "absolute" }}>
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="10" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
          {features.map((f, i) => {
            const on = highlight !== undefined && f.name.toLowerCase() === highlight.toLowerCase();
            return (
              <path key={i} d={f.d} vectorEffect="non-scaling-stroke"
                fill={on ? `rgba(255,106,31,${0.25 + 0.65 * lit})` : "#1c2840"} stroke={on ? theme.color.accent : "#34466a"}
                strokeWidth={on ? 3 : 1.4} filter={on && lit > 0.5 ? "url(#glow)" : undefined} />
            );
          })}
        </g>
        {pinDrop > 0.01 ? (
          <g transform={`translate(${screen.x} ${screen.y - (1 - Math.min(1, pinDrop)) * 120})`} opacity={Math.min(1, pinDrop * 2)}>
            {frame > 1.7 * fps ? <circle r={30 + ring * 90} fill="none" stroke={theme.color.accent} strokeWidth={5} opacity={Math.max(0, 1 - ring / 1.2)} /> : null}
            <path d="M0 0 C -26 -34 -40 -52 -40 -74 A 40 40 0 1 1 40 -74 C 40 -52 26 -34 0 0 Z" fill={theme.color.accent} stroke="#fff" strokeWidth={5} />
            <circle cy={-74} r={15} fill="#fff" />
          </g>
        ) : null}
      </svg>
      <div style={{
        position: "absolute", left: 0, right: 0, top: screen.y + 40, display: "flex", justifyContent: "center",
        opacity: interpolate(frame, [1.8 * fps, 2.2 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      }}>
        <span style={{
          fontFamily: theme.font.text, fontWeight: 800, fontSize: 54, color: "#fff", padding: "14px 30px", borderRadius: 22,
          background: "rgba(14,18,26,0.7)", backdropFilter: "blur(16px)", boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.14), 0 16px 40px rgba(0,0,0,0.4)",
        }}>
          {label}
        </span>
      </div>
    </AbsoluteFill>
  );
};

/** Full-frame map: flies from the whole country or world to a place and drops a pin. For "where". */
export const MapFocus: React.FC<Props> & { layoutOf: (p: Props) => LayoutDeclaration } = ({ from, to, sfx, ...rest }) => (
  <>
    <Clip from={from} to={to} name={`Map ${rest.label}`}><Body {...rest} /></Clip>
    <BlockSfx at={from} sfx={sfx} fallback="whoosh" volume={0.5} />
  </>
);
MapFocus.layoutOf = ({ from, to }) => ({ occupied: { from, to, zone: "full" } });
