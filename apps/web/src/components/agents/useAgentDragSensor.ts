import { useRef } from "react";

const AGENT_DRAG_DISTANCE = 6;

export function useAgentDragSensor() {
  const suppressClick = useRef(false);
  const pointerSensorOptions = {
    distance: AGENT_DRAG_DISTANCE,
    onAttach: () => {
      suppressClick.current = false;
    },
    onFinish: (started: boolean) => {
      suppressClick.current = started;
    },
  };
  const containerRef = (node: HTMLDivElement | null) => {
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
      clear();
    };
  };
  return { containerRef, pointerSensorOptions };
}
