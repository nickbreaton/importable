import { useRevalidator } from "@remix-run/react";
import { useEffect } from "react";

export function useRevalidateOnWindowFocus() {
  const revalidator = useRevalidator();
  useEffect(() => {
    const controller = new AbortController();
    window.addEventListener("focus", revalidator.revalidate, { signal: controller.signal });
    document.addEventListener("mouseenter", revalidator.revalidate, { signal: controller.signal });
    return () => controller.abort();
  }, [revalidator]);
}
