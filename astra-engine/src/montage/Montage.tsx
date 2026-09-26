// Kit check for Remotion Studio (put any vertical clip at public/dev/sample.mp4).
// In production this file is replaced by the montage Astra writes for each video.
import React from "react";
import { AstraVideo, BehindText, Captions, cam, SidePanel, Tag } from "../kit";

export const Montage: React.FC = () => (
  <AstraVideo camera={[cam.push(0, 2.2, 1.1), cam.reset(4.4)]}>
    <BehindText from={0.15} to={2.0} text="Биткоин" />
    <Tag from={2.3} to={4.2} text="Объясняю" />
    <SidePanel
      from={4.45}
      to={7.9}
      title="Почему нельзя подделать"
      items={[
        { text: "У каждого своя копия", at: 4.6 },
        { text: "Все сверяют записи", at: 5.5 },
        { text: "Подделку сразу видно", at: 6.95, tone: "accent" },
      ]}
    />
    <Captions emphasis={[0, 4, 12]} />
  </AstraVideo>
);
