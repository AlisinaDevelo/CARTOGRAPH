use crate::payments::charge;

mod payments;

pub fn process_order() {
    charge();
}
