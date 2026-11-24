import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

type User = { id: number; email: string; created_at: string };

export function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<User | null>(null);

  useEffect(() => {
    fetch(`${API}/api/users`)
      .then((r) => r.json())
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);

  // NOTE (eval task 2): this line crashes the list view when `users` is empty,
  // because users[0] is undefined. The fix is to guard for an empty array.
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
