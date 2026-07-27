import FeatNetwork from "./feat-network";
import { version as APP_VERSION } from "../package.json";

function App() {
  return (
    <>
      <FeatNetwork />
      {/* 全画面共通で右上に常時表示するアプリバージョン。動作確認・問い合わせ時に
          どのビルドを見ているか分かるようにする目的。スクロールしても隠れないようfixed */}
      <div
        style={{
          position: "fixed",
          zIndex: 999,
          top: "max(0.5rem, env(safe-area-inset-top))",
          right: "max(0.5rem, env(safe-area-inset-right))",
          fontSize: 10,
          color: "#9088A0",
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        v{APP_VERSION}
      </div>
    </>
  );
}

export default App;