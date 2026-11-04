import { useState, useRef } from 'react';
import { ShieldCheck, Square } from 'lucide-react';

export default function SelfTestPage() {
  const [isSearching, setIsSearching] = useState(false);
  const [output, setOutput] = useState<string>('Ready. Click "Start Search" to begin.');
  const eventSourceRef = useRef<EventSource | null>(null);

  // ⚠️ هنا خاصك تحط الرابط ديال الباك اند ديالك (FastAPI)
  // إلا كنتي كتجرب فـ PC ديالك، خليه http://127.0.0.1:7860
  // إلا كنتي كتستعمل Termux بـ Cloudflare، حط الرابط ديال cloudflared هنا
  const BACKEND_URL = 'https://platform-personality-cdna-privacy.trycloudflare.com';

  const startSearch = () => {
    setIsSearching(true);
    setOutput('Starting Plutus Default Search...\n===============================\n');
    
    // فتح اتصال مباشر مع FastAPI باش ناخدو اللوغات (Streaming)
    eventSourceRef.current = new EventSource(`${BACKEND_URL}/api/stream-search`);

    eventSourceRef.current.onmessage = (event) => {
      // كل سطر كيوصل من Plutus، كتزاد فـ الشاشة
      setOutput((prev) => prev + event.data + '\n');
    };

    eventSourceRef.current.onerror = () => {
      eventSourceRef.current?.close();
      setIsSearching(false);
      setOutput((prev) => prev + '\n[Search stopped or connection lost]');
    };
  };

  const stopSearch = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      // كنصيفطو طلب للباك اند باش يقتل العملية ديال Plutus
      fetch(`${BACKEND_URL}/api/stop-search`, { method: 'POST' }).catch(() => {});
    }
    setIsSearching(false);
    setOutput((prev) => prev + '\n[Search manually stopped by user]');
  };

  return (
    <main className="page-wrap">
      <section className="intro">
        <div className="eyebrow">Plutus Engine</div>
        <h1>Default Search</h1>
        <p className="intro-copy">
          This page triggers the actual Plutus search on the backend server.
        </p>
      </section>

      <section className="self-test-page" aria-label="Plutus Search">
        <div className="panel self-test-panel">
          <div className="section-kicker">
            <span className="step-number">01</span>
            Plutus Live Output
          </div>
          <p className="subhead">
            Click start to run the search. Results will appear below in real-time.
          </p>

          <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
            <button
              className="small-button"
              type="button"
              onClick={startSearch}
              disabled={isSearching}
              data-testid="button-run-self-test"
            >
              <ShieldCheck aria-hidden="true" /> Start Search
            </button>

            {isSearching && (
              <button
                type="button"
                onClick={stopSearch}
                style={{
                  padding: '10px 15px',
                  backgroundColor: '#ff4d4f',
                  color: 'white',
                  border: 'none',
                  borderRadius: '5px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px'
                }}
              >
                <Square size={16} /> Stop Search
              </button>
            )}
          </div>

          {/* شاشة عرض النتيجة (Terminal) */}
          <pre
            style={{
              backgroundColor: '#000',
              color: '#00ff00',
              padding: '15px',
              borderRadius: '8px',
              height: '400px',
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
              fontSize: '14px',
              border: '1px solid #333'
            }}
          >
            {output}
          </pre>
        </div>
      </section>
    </main>
  );
                  }
