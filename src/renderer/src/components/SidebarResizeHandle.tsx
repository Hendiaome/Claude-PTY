import { useCallback } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  clampSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH
} from "../../../shared/layout";

const KEYBOARD_RESIZE_STEP = 12;

type SidebarResizeHandleProps = {
  width: number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
};

/** 支持鼠标拖动和键盘方向键调整侧栏，结束操作时才提交持久化宽度。 */
export function SidebarResizeHandle({
  width,
  onChange,
  onCommit
}: SidebarResizeHandleProps): JSX.Element {
  const startResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      let nextWidth = width;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (moveEvent: MouseEvent): void => {
        nextWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
        onChange(nextWidth);
      };
      const onMouseUp = (): void => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        if (nextWidth !== startWidth) {
          onCommit(nextWidth);
        }
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [onChange, onCommit, width]
  );

  const resizeWithKeyboard = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }

      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const nextWidth = clampSidebarWidth(width + direction * KEYBOARD_RESIZE_STEP);
      if (nextWidth === width) {
        return;
      }

      onChange(nextWidth);
      onCommit(nextWidth);
    },
    [onChange, onCommit, width]
  );

  return (
    <div
      className="sidebar-resize-handle"
      role="separator"
      aria-label="调整会话面板宽度"
      aria-orientation="vertical"
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整会话面板宽度"
      onKeyDown={resizeWithKeyboard}
      onMouseDown={startResize}
    />
  );
}
