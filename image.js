const mongoose = require("mongoose");

const imageSchema = new mongoose.Schema({
  name: String,
  url: String,
  publicId: String
});

module.exports = mongoose.model("Image", imageSchema);
