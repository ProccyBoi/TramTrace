const lines = [
  { route: "L1", name: "Dulwich Hill Line", colour: "#BE1622" },
  { route: "L2", name: "Randwick Line", colour: "#DD1E25" },
  { route: "L3", name: "Kingsford Line", colour: "#781140" },
  { route: "L4", name: "Westmead & Carlingford Line", colour: "#BB2043" },
];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="eyebrow">
          <span className="live-dot" aria-hidden="true" />
          Live service
        </div>
        <h1>TramTrace</h1>
        <p className="lede">
          A live Sydney light rail feed for the physical TramTrace map.
        </p>

        <div className="line-grid" aria-label="Tracked light rail lines">
          {lines.map((line) => (
            <article className="line-card" key={line.route}>
              <span
                className="route-badge"
                style={{ backgroundColor: line.colour }}
              >
                {line.route}
              </span>
              <span>{line.name}</span>
            </article>
          ))}
        </div>

        <div className="service-note">
          <div>
            <span className="label">BOARD FEED</span>
            <strong>Protected</strong>
          </div>
          <div>
            <span className="label">UPDATE INTERVAL</span>
            <strong>3 seconds</strong>
          </div>
          <a href="/healthz">Service health</a>
        </div>
      </section>
      <footer>Unofficial project using Transport for NSW open data.</footer>
    </main>
  );
}
