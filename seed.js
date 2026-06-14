const db = require('./db');
const auth = require('./auth');

db.exec('DELETE FROM sessions; DELETE FROM order_items; DELETE FROM orders; DELETE FROM customers; DELETE FROM menu_items; DELETE FROM seats; DELETE FROM owners; DELETE FROM cafes;');

const cafes = [
  { id: 'cafe_brewbean', name: 'Brew & Bean', upi: 'brewbean@upi', email: 'brew@demo.com', seats: 8,
    menu: [
      ['Cappuccino', 12000, 'Coffee', 6], ['Cold Brew', 15000, 'Coffee', 4],
      ['Espresso', 9000, 'Coffee', 3], ['Masala Chai', 6000, 'Tea', 5],
      ['Veg Sandwich', 14000, 'Food', 10], ['Chocolate Cake', 18000, 'Desserts', 2],
      ['Croissant', 11000, 'Food', 4],
    ]},
  { id: 'cafe_chai', name: 'Chai Point', upi: 'chaipoint@upi', email: 'chai@demo.com', seats: 5,
    menu: [
      ['Kulhad Chai', 5000, 'Tea', 5], ['Ginger Chai', 5500, 'Tea', 5],
      ['Samosa', 4000, 'Snacks', 6], ['Maggi', 8000, 'Snacks', 9],
      ['Filter Coffee', 7000, 'Coffee', 4],
    ]},
];

const insCafe = db.prepare('INSERT INTO cafes (id,name,owner_email,upi_id,loyalty_rate) VALUES (?,?,?,?,10)');
const insOwner = db.prepare('INSERT INTO owners (cafe_id,email,pass_hash) VALUES (?,?,?)');
const insSeat = db.prepare('INSERT INTO seats (id,cafe_id,label) VALUES (?,?,?)');
const insItem = db.prepare('INSERT INTO menu_items (cafe_id,name,price,category,prep_mins) VALUES (?,?,?,?,?)');

const PASS = 'demo1234';
const base = 'http://localhost:3000/order.html?seat=';
for (const c of cafes) {
  insCafe.run(c.id, c.name, c.email, c.upi);
  insOwner.run(c.id, c.email, auth.hashPassword(PASS));
  console.log(`\n${c.name}  — login: ${c.email} / ${PASS}`);
  for (let i = 1; i <= c.seats; i++) {
    const token = `${c.id}_t${i}`;
    insSeat.run(token, c.id, `Table ${i}`);
    if (i <= 2) console.log(`   Table ${i} QR: ${base}${token}`);
  }
  for (const m of c.menu) insItem.run(c.id, m[0], m[1], m[2], m[3]);
}
console.log('\nSeed complete.');
console.log('   Owner login page: http://localhost:3000/login.html');
console.log('   Customer seat:    http://localhost:3000/order.html?seat=cafe_brewbean_t1\n');
