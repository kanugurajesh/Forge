import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Registry } from "./pages/Registry.tsx";
import { ProcedurePage } from "./pages/Procedure.tsx";
import { Compile } from "./pages/Compile.tsx";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function App() {
  const hash = useHash();
  const route = hash.replace(/^#\/?/, "");
  let page = <Registry />;
  if (route.startsWith("p/")) page = <ProcedurePage name={decodeURIComponent(route.slice(2))} />;
  else if (route.startsWith("compile")) page = <Compile />;

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <a className="brand" href="#/">
            <img src="/favicon.svg" width={22} height={22} alt="" />
            Forge <small>procedures for BrowserOps</small>
          </a>
          <nav className="nav">
            <a href="#/" className={!route || route.startsWith("p/") ? "active" : ""}>
              Registry
            </a>
            <a href="#/compile" className={route.startsWith("compile") ? "active" : ""}>
              Compile a run
            </a>
            <a href="/demo/" target="_blank" rel="noreferrer">
              Demo app ↗
            </a>
          </nav>
          <a className="btn sm" href="https://www.browserops.ai/docs/procedures" target="_blank" rel="noreferrer">
            Procedures docs
          </a>
        </div>
      </header>
      <main className="wrap">{page}</main>
      <footer>
        <div className="wrap">
          Forge validates against the BrowserOps v1 procedure schema and uses BrowserOps' own locator tiers and drift thresholds (ported from the MIT-licensed
          <code> browserops</code> package). An independent project, not affiliated with Quay Labs.
        </div>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
