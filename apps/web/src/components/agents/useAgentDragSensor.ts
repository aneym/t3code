import { useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";

const AGENT_DRAG_DISTANCE = 6;

export function useAgentDragSensor() {
  const suppressClick = useRef(false);
  const [pointerSensorOptions] = useState(() => ({
    distance: AGENT_DRAG_DISTANCE,
    onAttach: () => {},
    onFinish: (started: boolean) => {
      if (started) suppressClick.current = true;
    },
  }));
  const containerRef = useStableCallback((node: HTMLDivElement | null) => {
    const window = node?.ownerDocument.defaultView;
    if (!node || !window) return;
    const clear = () => {
      suppressClick.current = false;
    };
    const preventDragClick = (event: MouseEvent) => {
      if (
        !suppressClick.current ||
        !(event.target instanceof Node) ||
        !node.contains(event.target)
      ) {
        return;
      }
      event.preventDefault();
      clear();
    };
    window.addEventListener("click", preventDragClick, true);
    window.addEventListener("pointerdown", clear, true);
    return () => {
      window.removeEventListener("click", preventDragClick, true);
      window.removeEventListener("pointerdown", clear, true);
    };
  });
  return { containerRef, pointerSensorOptions };
}
