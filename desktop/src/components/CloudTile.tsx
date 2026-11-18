import { Cloud } from "lucide-react";
import { cloudColorFill } from "@/lib/cloud-look";

/** A saved workspace's cloud mark, using its identity colour in the current skin. */
export function CloudTile({ color, size = 22 }: { color: unknown; size?: number }) {
  return <span aria-hidden="true" style={{ width: size, height: size, background: cloudColorFill(color) }}
    className="grid shrink-0 place-items-center rounded-[7px] text-white"><Cloud size={Math.round(size * 0.62)} strokeWidth={2.2} /></span>;
}
