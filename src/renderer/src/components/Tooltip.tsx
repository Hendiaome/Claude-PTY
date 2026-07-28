import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_GAP = 7;
const VIEWPORT_PADDING = 8;

type TooltipPosition = {
  top: number;
  left: number;
};

type TooltipProps = {
  children: ReactNode;
  content: string;
  focusableWhenDisabled?: boolean;
};

/** 通过 Portal 绕过侧栏滚动裁切，并为禁用按钮保留键盘可访问的原因提示。 */
export function Tooltip({ children, content, focusableWhenDisabled = false }: TooltipProps): JSX.Element {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ top: -9999, left: -9999 });

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) {
      return;
    }

    // 根据上下空间自动翻转，并把横向位置限制在视口安全边距内。
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const showAbove = spaceBelow < tooltipRect.height + TOOLTIP_GAP && triggerRect.top > spaceBelow;
    const preferredLeft = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - tooltipRect.width - VIEWPORT_PADDING);

    setPosition({
      top: showAbove
        ? Math.max(VIEWPORT_PADDING, triggerRect.top - tooltipRect.height - TOOLTIP_GAP)
        : Math.min(window.innerHeight - tooltipRect.height - VIEWPORT_PADDING, triggerRect.bottom + TOOLTIP_GAP),
      left: Math.min(Math.max(VIEWPORT_PADDING, preferredLeft), maxLeft)
    });
  }, []);

  useLayoutEffect(() => {
    if (visible) {
      updatePosition();
    }
  }, [content, updatePosition, visible]);

  useEffect(() => {
    if (!visible) {
      return undefined;
    }

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [updatePosition, visible]);

  return (
    <span
      ref={triggerRef}
      className="tooltip-trigger"
      aria-describedby={visible ? tooltipId : undefined}
      aria-label={focusableWhenDisabled ? content : undefined}
      tabIndex={focusableWhenDisabled ? 0 : undefined}
      title={visible ? undefined : content}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setVisible(false);
        }
      }}
      onFocus={() => setVisible(true)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              className="app-tooltip"
              role="tooltip"
              style={{ top: position.top, left: position.left }}
            >
              {content}
            </div>,
            document.body
          )
        : null}
    </span>
  );
}
