# WebRTC Save

A server-side peer for saving collaborative code editing sessions in the [Sprig](https://sprig.hackclub.com/) editor.

## Setting up

- Make sure you have Docker installed on your computer
- Clone the repository and build the docker container by running
```sh
docker build --platform linux/amd64 -t webrtc-save .
```

- Then run the docker container using
```sh
docker run --platform linux/amd64 -it webrtc-save
```
Again, replacing *yjswebrtc-node* with the name you chosed previously.
