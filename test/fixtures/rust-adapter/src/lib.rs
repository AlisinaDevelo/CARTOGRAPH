use crate::payments::charge;
use reqwest::Client;
use sqlx::query;

mod payments;

pub struct OrdersService;

impl OrdersService {
    pub async fn load_orders(&self, client: &Client, destination: &str) {
        let _rows = sqlx::query("SELECT id FROM orders");
        let _ = reqwest::get("https://payments.example/charge");
        charge();
        let _ = client.get(destination);
        let query_text = "SELECT id FROM";
        sqlx::query(query_text);
    }
}

pub fn entry() {
    load_orders();
}
