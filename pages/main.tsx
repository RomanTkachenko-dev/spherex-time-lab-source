import { createRoot } from "react-dom/client";
import Observatory from "../app/observatory";
import "../app/globals.css";
import "../app/observatory.css";

// This file is the browser entry of the GitHub Pages build. The vinext dev/SSR server also
// loads files under pages/ on the server, where `document` does not exist, so mount only in
// the browser. The default export keeps the module a harmless (empty) page for vinext.
if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<Observatory />);
}

export default function PagesEntry() {
  return null;
}
