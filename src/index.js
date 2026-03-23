async function login() {
  const res = await fetch('/api/login',{
    method:'POST',
    body:JSON.stringify({
      email:email.value,
      password:password.value
    })
  });

  const data = await res.json();

  if (data.error) {
    alert(data.error);
    return;
  }

  if(data.userId){
    userId = data.userId;
    chat.style.display='block';
    alert("Login successful");
    load();
  } else {
    alert("Login failed");
  }
}
