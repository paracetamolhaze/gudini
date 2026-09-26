import { createContext, useContext } from "react";

/** Screen area a block occupies for a while; captions and the camera make room for it. */
export type Zone = "bottom" | "top" | "left" | "right" | "full";
export type Occupied = { from: number; to: number; zone: Zone };

export const LayoutContext = createContext<Occupied[]>([]);
export const useOccupied = () => useContext(LayoutContext);

export function zonesAt(occupied: Occupied[], t: number): Zone[] {
  return occupied.filter(o => t >= o.from && t < o.to).map(o => o.zone);
}
