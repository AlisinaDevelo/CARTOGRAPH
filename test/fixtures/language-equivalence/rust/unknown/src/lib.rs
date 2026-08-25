pub fn process_order(destination: &str, query_text: &str) {
    reqwest::get(destination);
    sqlx::query(query_text);
}
