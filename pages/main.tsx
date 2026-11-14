import { createRoot } from "react-dom/client";
import Observatory from "../app/observatory";
import "../app/globals.css";
import "../app/observatory.css";

createRoot(document.getElementById("root")!).render(<Observatory />);
