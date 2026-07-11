// The shell the MVP panels get hung off. The run rail, gate strip, canvas, feed and
// inspector arrive with their own tickets (#15–#20); this ticket only proves the
// frontend builds, boots and is testable in jsdom.
export function App() {
  return (
    <main>
      <h1>orca-viz</h1>
      <p>Read-only visualizer for Orca&rsquo;s orchestration database.</p>
    </main>
  );
}
