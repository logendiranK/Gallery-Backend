const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Image = require('./image'); 
const https = require('https');
const { URL } = require('url');
dotenv.config();

const app = express();


app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'gallery',
    allowed_formats: ['jpg', 'jpeg', 'png'],
    // remove transformation for faster uploads; do delivery-time transforms via Cloudinary URLs
  },
});

const upload = multer({ storage });


const mongoURI = process.env.MONGO_URI;
const port = process.env.PORT || 5000;

mongoose.connect(mongoURI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const imageUrl = req.file.path;
    const publicId = req.file.filename; // cloudinary public_id

    const newImage = new Image({
      name: req.file.originalname,
      url: imageUrl,
      publicId: publicId,
    });

    await newImage.save();

    res.status(200).json({ url: imageUrl, id: newImage._id, publicId });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ message: "Upload failed", error });
  }
});


const headExists = (targetUrl) => new Promise((resolve) => {
  try {
    const url = new URL(targetUrl);
    const options = {
      method: 'HEAD',
      hostname: url.hostname,
      path: url.pathname + (url.search || ''),
      protocol: url.protocol,
    };
    const req = https.request(options, (resp) => {
      resolve(resp.statusCode && resp.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.end();
  } catch (_) {
    resolve(false);
  }
});

app.get('/images', async (req, res) => {
  try {
    const images = await Image.find();
    const valid = [];
    const toDeleteIds = [];

    for (const img of images) {
      let exists = false;
      if (img.publicId) {
        try {
          // Uses Cloudinary Admin API; will throw if missing
          // eslint-disable-next-line no-await-in-loop
          await cloudinary.api.resource(img.publicId);
          exists = true;
        } catch (e) {
          exists = false;
        }
      } else if (img.url) {
        // eslint-disable-next-line no-await-in-loop
        exists = await headExists(img.url);
      }

      if (exists) {
        valid.push(img);
      } else {
        toDeleteIds.push(img._id);
      }
    }

    if (toDeleteIds.length > 0) {
      await Image.deleteMany({ _id: { $in: toDeleteIds } });
    }

    res.status(200).json(valid);
  } catch (error) {
    console.error("Error fetching images:", error);
    res.status(500).json({ message: "Failed to fetch images" });
  }
});

app.delete('/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const image = await Image.findById(id);
    if (!image) {
      return res.status(404).json({ message: 'Image not found' });
    }

    if (image.publicId) {
      await cloudinary.uploader.destroy(image.publicId);
    }

    await image.deleteOne();
    res.status(200).json({ message: 'Deleted' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ message: 'Failed to delete image' });
  }
});

// Cloudinary webhook to auto-clean Mongo when assets are deleted in Cloudinary
app.post('/webhooks/cloudinary', async (req, res) => {
  try {
    const token = req.query.token;
    const expected = process.env.CLOUDINARY_WEBHOOK_TOKEN;
    if (!expected || token !== expected) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const payload = req.body || {};
    // Cloudinary deletion notifications may include either a single resource or an array
    const notificationType = payload.notification_type || payload.type;

    // Handle both bulk and single delete payloads
    const publicIds = [];
    if (Array.isArray(payload.resources)) {
      for (const r of payload.resources) {
        if (r && r.public_id) publicIds.push(r.public_id);
      }
    } else if (payload.public_id) {
      publicIds.push(payload.public_id);
    }

    if ((notificationType && notificationType.toLowerCase() === 'delete') || publicIds.length > 0) {
      if (publicIds.length === 0 && payload.resource && payload.resource.public_id) {
        publicIds.push(payload.resource.public_id);
      }

      if (publicIds.length > 0) {
        await Image.deleteMany({ publicId: { $in: publicIds } });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ message: 'Webhook processing failed' });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
