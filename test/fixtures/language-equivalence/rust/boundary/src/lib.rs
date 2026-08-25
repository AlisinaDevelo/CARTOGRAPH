pub fn process_order() {
    reqwest::get("https://payments.example/charge");
}
