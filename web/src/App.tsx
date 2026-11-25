import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

type User = { id: number; email: string; created_at: string };

export function App() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<User | null>(null);

  useEffect(() => {
    fetch(`${API}/api/users`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setUsers)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <main style={{ fontFamily: "system-ui", padding: 24 }}>Could not load users: {error}</main>;
  if (!users) return <main style={{ fontFamily: "system-ui", padding: 24 }}>Loading…</main>;

  const firstEmail = users[0].email;

  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 640 }}>
      <h1>token-lab users</h1>
      <p>First user: {firstEmail}</p>
      <ul>
        {users.map((u) => (
          <li key={u.id}>
            <button onClick={() => setSelected(u)}>{u.email}</button>
          </li>
        ))}
      </ul>
      {selected && (
        <section>
          <h2>{selected.email}</h2>
          <p>id: {selected.id}</p>
          <p>created: {selected.created_at}</p>
        </section>
      )}
    </main>
  );
}
