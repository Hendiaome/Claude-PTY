import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";
import { FloatingStatusApp } from "./FloatingStatusApp";

const floatingWindow = new URLSearchParams(window.location.search).get("window") === "floating";
document.documentElement.dataset.window = floatingWindow ? "floating" : "main";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {floatingWindow ? <FloatingStatusApp /> : <App />}
  </React.StrictMode>
);
