async function register() {
  const name = document.getElementById("name").value;
  const password = document.getElementById("password").value;

  const res = await fetch("/api/register", {
    method: "POST",
    body: JSON.stringify({ name, password })
  });

  const data = await res.json();

  if (data.success) {
    alert("Your number: " + data.userNumber);
  } else {
    alert("Failed");
  }
}

async function login() {
  const userNumber = document.getElementById("loginNumber").value;
  const password = document.getElementById("loginPassword").value;

  const res = await fetch("/api/login", {
    method: "POST",
    body: JSON.stringify({ userNumber, password })
  });

  const data = await res.json();

  if (data.success) {
    document.getElementById("result").innerText = "Logged in!";
  } else {
    alert("Invalid login");
  }
}
