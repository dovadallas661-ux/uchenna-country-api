const express = require("express");
const router = express.Router();

const controller = require("../controllers/countryController");

router.post("/refresh", controller.refresh);
router.post("/", controller.createCountry);

router.get("/image", controller.getImage);

router.get("/", controller.getCountries);

router.get("/:name", controller.getCountry);

router.put("/:name", controller.updateCountry);

router.delete("/:name", controller.deleteCountry);

module.exports = router;
