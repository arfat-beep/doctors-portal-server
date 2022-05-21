const express = require("express");
const app = express();
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const query = require("express/lib/middleware/query");
var nodemailer = require("nodemailer");
var sgTransport = require("nodemailer-sendgrid-transport");
require("dotenv").config();
const port = process.env.PORT || 5000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
// middleware
app.use(cors());
app.use(express.json());

const emailSenderOptions = {
  auth: {
    api_key:
      "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",
  },
};
const emailClient = nodemailer.createTransport(sgTransport(emailSenderOptions));

const uri =
  "mongodb+srv://doctors_portal_admin:23vkZrrEIV6b6OuS@cluster0.dndku.mongodb.net/myFirstDatabase?retryWrites=true&w=majority";
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});
const verfifyJWT = (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = authorization.split(" ")[1];
  jwt.verify(token, process.env.SECRET_KEY, (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.decoded = decoded;
    next();
  });
};
async function run() {
  try {
    await client.connect();
    const serviceCollection = client.db("doctorsPortal").collection("Service");
    const bookingCollection = client.db("doctorsPortal").collection("Booking");
    const usersCollection = client.db("doctorsPortal").collection("Users");
    const doctorCollection = client.db("doctorsPortal").collection("doctors");
    const paymentCollection = client.db("doctorsPortal").collection("payments");

    // get all services for appointment page
    app.get("/service", async (req, res) => {
      const query = {};
      const cursor = await serviceCollection
        .find(query)
        .project({ name: 1 })
        .toArray();
      // const services = await cursor;
      res.send(cursor);
    });
    app.get("/user", verfifyJWT, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    app.post("/create-payment-intent", verfifyJWT, async (req, res) => {
      const service = req.body;
      const price = service.price;
      const amount = price * 100;
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        payment_method_types: ["card"],
      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    const verifyAdmin = async (req, res, next) => {
      const requesterEmail = req?.decoded?.email;
      const requesterRole = await usersCollection.findOne({
        email: requesterEmail,
      });
      if (requesterRole.role === "admin") {
        next();
      } else {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    app.put("/user/admin/:email", verfifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;

      const filter = { email };
      const updateDoc = {
        $set: { role: "admin" },
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.get("/admin/:email", async (req, res) => {
      const email = req.params.email;
      const data = await usersCollection.findOne({ email });
      const isAdmin = data.role === "admin";
      res.send({ admin: isAdmin });
    });

    app.put("/user/:email", async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const filter = { email };
      const option = { upsert: true };
      const upDoc = {
        $set: user,
      };
      const result = await usersCollection.updateOne(filter, upDoc, option);
      const token = jwt.sign({ email }, process.env.SECRET_KEY, {
        expiresIn: "1h",
      });

      res.send({ result, token });
    });

    app.get("/available", async (req, res) => {
      const date = req.query.date;

      // step 1 : get all services
      const services = await serviceCollection.find().toArray();
      // res.send(services);

      // step 2: get the booking of that day
      const query = { date };
      const bookings = await bookingCollection.find(query).toArray();
      // res.send(bookings);

      services.forEach((service) => {
        const serviceBooking = bookings.filter(
          (b) => b.treatment === service.name
        );
        booked = serviceBooking.map((s) => s.slot);
        service.slots = service.slots.filter((s) => !booked.includes(s));
      });

      res.send(services);
    });
    app.get("/booking", verfifyJWT, async (req, res) => {
      const patinetEmail = req.query.patient;
      const decodedEmail = req?.decoded?.email;
      if (decodedEmail === patinetEmail) {
        const query = { patinetEmail };
        const bookings = await bookingCollection.find(query).toArray();
        res.send(bookings);
      } else {
        return res.status(403).send({ message: "forbidden access" });
      }
    });

    app.post("/booking", async (req, res) => {
      const booking = req.body;
      const query = {
        treatment: booking.treatment,
        date: booking.date,
        patient: booking.patientEmail,
      };

      const exist = await bookingCollection.findOne(query);
      if (exist) {
        return res.send({ success: false, exist });
      }
      const result = await bookingCollection.insertOne(booking);
      sendAppointmentEmail(
        booking.patinetEmail,
        booking.patientName,
        booking.date,
        booking.slot
      );
      return res.send({ success: true, result });
    });

    app.get("/booking/:id", verfifyJWT, async (req, res) => {
      const id = req.params.id;
      const query = { _id: ObjectId(id) };
      const booking = await bookingCollection.findOne(query);
      res.send(booking);
    });
    app.patch("/booking/:id", verfifyJWT, async (req, res) => {
      const id = req.params.id;
      const payment = req.body;
      const query = { _id: ObjectId(id) };
      const option = { upsert: true };
      const upDoc = {
        $set: { paid: true, transactionId: payment.transactionId },
      };
      const updatedBooking = await bookingCollection.updateOne(
        query,
        upDoc
      );
      const result = await paymentCollection.insertOne(payment);
      res.send(upDoc);
    });
    app.post("/doctor", verfifyJWT, verifyAdmin, async (req, res) => {
      const doctor = req.body;
      const result = await doctorCollection.insertOne(doctor);
      res.send(result);
    });

    app.delete("/doctor/:email", verfifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const result = await doctorCollection.deleteOne(query);
      res.send(result);
    });

    app.get("/doctor", verfifyJWT, verifyAdmin, async (req, res) => {
      const result = await doctorCollection.find().toArray();
      res.send(result);
    });
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);
app.get("/", (req, res) => {
  res.send("Hello from  doctor uncle!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
